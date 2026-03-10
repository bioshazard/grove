import type { Database } from './db';
import { symbolQuery, resolveSymbolId } from './parser';

export interface EvalOptions {
  timeout?: number;
  sandbox?: boolean;
  captureTraces?: boolean;
}

export interface EvalResult {
  success: boolean;
  value?: unknown;
  error?: string;
  traces?: TraceSpan[];
  durationMs: number;
}

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, unknown>;
  symbolId?: number;
}

let currentTraceId = 0;

function generateSpanId(): string {
  return `span-${Date.now()}-${++currentTraceId}`;
}

export function captureTraces<T>(fn: (startSpan: (name: string, symbolId?: number) => TraceSpan, endSpan: (span: TraceSpan, error?: unknown) => void) => T): { result: T; traces: TraceSpan[] } {
  const captured: TraceSpan[] = [];
  const traceStack: TraceSpan[] = [];
  
  function startSpan(name: string, symbolId?: number): TraceSpan {
    const span: TraceSpan = {
      spanId: generateSpanId(),
      parentSpanId: traceStack.length > 0 ? traceStack[traceStack.length - 1]!.spanId : null,
      name,
      startTime: Date.now(),
      endTime: 0,
      attributes: {},
      symbolId,
    };
    traceStack.push(span);
    captured.push(span);
    return span;
  }

  function endSpan(span: TraceSpan, error?: unknown): void {
    const index = traceStack.indexOf(span);
    if (index !== -1) {
      traceStack.splice(index, 1);
    }
    span.endTime = Date.now();
    const durationMs = span.endTime - span.startTime;
    span.attributes.duration_ms = durationMs;
    if (error) {
      span.attributes.error = String(error);
    }
  }
  
  let result: T;
  try {
    result = fn(startSpan, endSpan);
  } catch (error) {
    for (const span of traceStack) {
      endSpan(span, error);
    }
    throw error;
  }
  
  for (const span of traceStack) {
    endSpan(span);
  }
  
  return { result, traces: captured };
}

export function evalCode(
  db: Database,
  code: string,
  options: EvalOptions = {}
): EvalResult {
  const { timeout = 5000, sandbox = true, captureTraces: shouldCaptureTraces = false } = options;
  
  const startTime = Date.now();
  const traces: TraceSpan[] = [];
  
  try {
    let result: unknown;
    
    if (shouldCaptureTraces) {
      const captured = captureTraces((startSpan, endSpan) => {
        return eval(code);
      });
      result = captured.result;
      traces.push(...captured.traces);
    } else {
      result = eval(code);
    }
    
    return {
      success: true,
      value: result,
      traces: shouldCaptureTraces ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      traces: shouldCaptureTraces ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}

function stripTypeScriptAnnotations(code: string): string {
  let result = code;
  
  // Remove return type annotation: ): Type{ -> ){
  result = result.replace(/\)\s*:\s*\{/, '){');
  // Remove simple return type: ): number -> )
  result = result.replace(/\)\s*:\s*\w+/g, ')');
  
  // Remove parameter type annotations
  result = result.replace(/([^:,=]+):\s*([^,)]+)/g, function(m, p1, p2) {
    if (/[a-zA-Z_]\w*$/.test(p1.trim()) && /^[{a-zA-Z]/.test(p2)) {
      return p1;
    }
    return m;
  });
  
  // Remove const/let/var type annotations
  result = result.replace(/\bconst\s+\w+\s*:\s*/g, 'const ');
  result = result.replace(/\blet\s+\w+\s*:\s*/g, 'let ');
  result = result.replace(/\bvar\s+\w+\s*:\s*/g, 'var ');
  
  return result;
}

export function evalSymbol(
  db: Database,
  symbolName: string,
  args: unknown[],
  options: EvalOptions = {}
): EvalResult {
  const symbols = symbolQuery(db, symbolName);
  if (symbols.length === 0) {
    return {
      success: false,
      error: `Symbol '${symbolName}' not found`,
      durationMs: 0,
    };
  }
  
  const symbol = symbols[0]!;
  const symbolId = symbol.id;
  
  const fileQuery = db.prepare(`
    SELECT f.path, f.source
    FROM files f
    JOIN nodes n ON n.file_id = f.id
    WHERE n.id = ?
  `);
  
  let node = fileQuery.get(symbol.definition_node_id) as { path: string; source: string } | undefined;
  if (!node) {
    return {
      success: false,
      error: `Could not find source for symbol '${symbolName}'`,
      durationMs: 0,
    };
  }
  
  const source = node.source;
  
  const funcStartQuery = db.prepare(`
    SELECT start, end FROM nodes WHERE id = ?
  `);
  const funcNode = funcStartQuery.get(symbol.definition_node_id) as { start: number; end: number } | undefined;
  
  if (!funcNode) {
    return {
      success: false,
      error: `Could not find node bounds for symbol '${symbolName}'`,
      durationMs: 0,
    };
  }
  
  const funcText = source.substring(funcNode.start, funcNode.end);
  const jsFuncText = stripTypeScriptAnnotations(funcText);
  
  const argValues = args.map(arg => {
    if (typeof arg === 'function') {
      return arg.toString();
    }
    return JSON.stringify(arg);
  }).join(', ');
  
  const evalCode = `
${jsFuncText}

__result = ${symbolName}(${argValues});
  `;
  
  const startTime = Date.now();
  const traces: TraceSpan[] = [];
  
  try {
    let result: unknown;
    
    if (options.captureTraces !== false) {
      const captured = captureTraces((startSpan, endSpan) => {
        const func = new Function('startSpan', 'endSpan', `
${evalCode}
          return typeof __result !== 'undefined' ? __result : undefined;
        `);
        return func(startSpan, endSpan);
      });
      result = captured.result;
      traces.push(...captured.traces);
    } else {
      const func = new Function(`
${evalCode}
        return typeof __result !== 'undefined' ? __result : undefined;
      `);
      result = func();
    }
    
    if (options.captureTraces !== false && traces.length > 0) {
      traces[0]!.name = `${symbolName} call`;
      traces[0]!.symbolId = symbolId;
    }
    
    return {
      success: true,
      value: result,
      traces: options.captureTraces !== false ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      traces: options.captureTraces !== false ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}

export function evalExpression(
  db: Database,
  expression: string,
  context?: Record<string, unknown>,
  options: EvalOptions = {}
): EvalResult {
  const startTime = Date.now();
  const traces: TraceSpan[] = [];
  
  try {
    let result: unknown;
    
    const contextVars = context ? Object.entries(context).map(([k, v]) => `var ${k} = ${JSON.stringify(v)};`).join('\n') : '';
    
    if (options.captureTraces !== false) {
      const captured = captureTraces((startSpan, endSpan) => {
        const func = new Function('startSpan', 'endSpan', `
${contextVars}
          var __result = ${expression};
          return __result;
        `);
        return func(startSpan, endSpan);
      });
      result = captured.result;
      traces.push(...captured.traces);
    } else {
      const func = new Function(contextVars + '\n' + 'return ' + expression);
      result = func();
    }
    
    return {
      success: true,
      value: result,
      traces: options.captureTraces !== false ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      traces: options.captureTraces !== false ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}

export function insertCapturedTraces(db: Database, spans: TraceSpan[]): number[] {
  const ids: number[] = [];
  const insertStmt = db.prepare(`
    INSERT INTO traces (span_id, parent_span_id, name, start_time, end_time, attributes, symbol_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const span of spans) {
    const result = insertStmt.run(
      span.spanId,
      span.parentSpanId || null,
      span.name,
      span.startTime,
      span.endTime,
      JSON.stringify(span.attributes),
      span.symbolId ?? null
    );
    ids.push(Number(result.lastInsertRowid));
  }
  
  return ids;
}
