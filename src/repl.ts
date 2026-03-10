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
        const wrappedCode = `
          (function(startSpan, endSpan) {
            ${code}
            return typeof __result !== 'undefined' ? __result : lastValue;
          })
        `;
        const func = new Function('startSpan', 'endSpan', wrappedCode);
        result = func(startSpan, endSpan);
        return result;
      });
      result = captured.result;
      traces.push(...captured.traces);
    } else {
      const wrappedCode = `
        (function() {
          var lastValue;
          ${code.replace(/;/g, '; lastValue = $&').replace(/lastValue; lastValue/g, 'lastValue')}
          return typeof __result !== 'undefined' ? __result : lastValue;
        })
      `;
      const func = new Function(wrappedCode);
      result = func();
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
  const lines = source.split('\n');
  
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
  
  const funcStartLine = (() => {
    let line = 0;
    let pos = 0;
    while (pos < funcNode.start && pos < source.length) {
      if (source[pos] === '\n') line++;
      pos++;
    }
    return line + 1;
  })();
  
  const funcText = source.substring(funcNode.start, funcNode.end);
  
  const argValues = args.map(arg => {
    if (arg instanceof Function) {
      return arg.toString();
    }
    return JSON.stringify(arg);
  }).join(', ');
  
  let evalCode = `
${source}

__result = ${symbolName}(${argValues});
  `;
  
  const startTime = Date.now();
  const traces: TraceSpan[] = [];
  
  try {
    let result: unknown;
    
    if (options.captureTraces !== false) {
      const captured = captureTraces(() => {
        const func = new Function('startSpan', 'endSpan', `
${evalCode}
          return typeof __result !== 'undefined' ? __result : undefined;
        `);
        result = func(startSpan, endSpan);
      });
      result = captured.result;
      traces.push(...captured.traces);
    } else {
      const func = new Function(evalCode);
      func();
      result = (globalThis as any).__result;
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
    
    const contextVars = context ? Object.entries(context).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n') : '';
    
    if (options.captureTraces !== false) {
      const captured = captureTraces(() => {
        const func = new Function('startSpan', 'endSpan', `
${contextVars}
          ${expression}
          return typeof __result !== 'undefined' ? __result : undefined;
        `);
        result = func(startSpan, endSpan);
      });
      result = captured.result;
      traces.push(...captured.traces);
    } else {
      const func = new Function(contextVars + '\n' + expression);
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
