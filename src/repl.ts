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
  
  // Remove export keyword from declarations
  result = result.replace(/^export\s+/gm, '');
  
  // Remove return type annotation: ): Type { -> ) {
  result = result.replace(/\)\s*:\s*\w+\s*(\{)/g, '){');
  
  // Remove parameter type annotations using lookbehind
  // Match : type only when preceded by an identifier and followed by ) or ,
  result = result.replace(/(?<=[a-zA-Z_]\w*)\s*:\s*(?:string|number|boolean|object|any|null|undefined|[A-Z]\w*|string\s*\|\s*null\s*\|\s*undefined)(?=\s*[),])/g, '');
  
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

export interface ReplSession {
  context: Record<string, unknown>;
  sandbox?: boolean;
  timeout?: number;
}

export function createReplSession(options?: { sandbox?: boolean; timeout?: number }): ReplSession {
  return {
    context: {},
    sandbox: options?.sandbox ?? true,
    timeout: options?.timeout ?? 5000,
  };
}

export function loadSymbolsIntoRepl(db: Database, session: ReplSession): { loaded: string[]; errors: string[] } {
  const loaded: string[] = [];
  const errors: string[] = [];
  
  const symbols = db.prepare(`
    SELECT s.id, s.name, s.kind, f.path, f.source
    FROM symbols s
    JOIN nodes n ON s.definition_node_id = n.id
    JOIN files f ON n.file_id = f.id
  `).all() as Array<{ id: number; name: string; kind: string; path: string; source: string }>;
  
  // Group symbols by file to avoid re-parsing
  const symbolsByFile = new Map<string, typeof symbols>();
  for (const symbol of symbols) {
    if (!symbolsByFile.has(symbol.path)) {
      symbolsByFile.set(symbol.path, []);
    }
    symbolsByFile.get(symbol.path)!.push(symbol);
  }
  
  // Process each file's symbols
  for (const [filePath, fileSymbols] of symbolsByFile.entries()) {
    try {
      // Get the full source for this file
      const fileQuery = db.prepare(`
        SELECT f.source FROM files f WHERE f.path = ?
      `);
      const fileData = fileQuery.get(filePath) as { source: string } | undefined;
      if (!fileData) continue;
      
      // Extract and evaluate each symbol
      for (const symbol of fileSymbols) {
        const funcStartQuery = db.prepare(`
          SELECT start, end FROM nodes WHERE id = (
            SELECT definition_node_id FROM symbols WHERE id = ?
          )
        `);
        const funcNode = funcStartQuery.get(symbol.id) as { start: number; end: number } | undefined;
        
        if (!funcNode) {
          errors.push(`Could not find node bounds for symbol '${symbol.name}'`);
          continue;
        }
        
        const funcText = fileData.source.substring(funcNode.start, funcNode.end);
        const jsFuncText = stripTypeScriptAnnotations(funcText);
        
        // Create a function from the declaration using exports pattern
        let fn: unknown;
        try {
          if (symbol.kind === 'function' || symbol.kind === 'class') {
            // Use Object.defineProperty to extract the function from a new scope
            const wrapperCode = `\n${jsFuncText}\nObject.defineProperty(exports, "${symbol.name}", { value: ${symbol.name} });`;
            const exports: Record<string, unknown> = {};
            new Function('exports', wrapperCode)(exports);
            fn = exports[symbol.name];
          } else {
            continue;
          }
        } catch (e) {
          errors.push(`Failed to eval symbol '${symbol.name}': ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        
        session.context[symbol.name] = fn;
        loaded.push(symbol.name);
      }
    } catch (error) {
      errors.push(`Failed to process file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  return { loaded, errors };
}

export function replCallSymbol(
  db: Database,
  session: ReplSession,
  symbolName: string,
  args: unknown[] = [],
  options?: { captureTraces?: boolean }
): EvalResult {
  const fn = session.context[symbolName];
  
  if (typeof fn !== 'function') {
    return {
      success: false,
      error: `Symbol '${symbolName}' not found in REPL context. Call loadSymbolsIntoRepl first.`,
      durationMs: 0,
    };
  }
  
  const startTime = Date.now();
  const traces: TraceSpan[] = [];
  
  try {
    let result: unknown;
    
    if (options?.captureTraces) {
      const captured = captureTraces((startSpan, endSpan) => {
        const argStrs = args.map(a => JSON.stringify(a)).join(', ');
        const funcCode = fn.toString();
        const wrappedFn = new Function('startSpan', 'endSpan', `
          ${funcCode}
          return ${symbolName}(${argStrs});
        `);
        return wrappedFn(startSpan, endSpan);
      });
      result = captured.result;
      traces.push(...captured.traces);
    } else {
      result = fn.apply(null, args);
    }
    
    return {
      success: true,
      value: result,
      traces: options?.captureTraces ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      traces: options?.captureTraces ? traces : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}

export function replUpdateSymbol(
  session: ReplSession,
  symbolName: string,
  newCode: string
): EvalResult {
  try {
    const jsCode = stripTypeScriptAnnotations(newCode);
    // Use exports pattern to extract the function
    const wrapperCode = `\n${jsCode}\nObject.defineProperty(exports, "${symbolName}", { value: ${symbolName} });`;
    const exports: Record<string, unknown> = {};
    new Function('exports', wrapperCode)(exports);
    const fn = exports[symbolName];
    
    if (typeof fn !== 'function' && typeof fn !== 'object') {
      return {
        success: false,
        error: `Updated code did not produce a function or class`,
        durationMs: 0,
      };
    }
    
    session.context[symbolName] = fn;
    
    return {
      success: true,
      value: fn,
      durationMs: 0,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    };
  }
}

export function replWriteback(
  db: Database,
  session: ReplSession,
  symbolName: string
): { success: boolean; error?: string } {
  const fn = session.context[symbolName];
  
  if (fn === undefined) {
    return { success: false, error: `Symbol '${symbolName}' not found in REPL context` };
  }
  
  try {
    const symbols = db.prepare(`
      SELECT s.id, s.name, s.kind, f.path, f.source, n.start, n.end
      FROM symbols s
      JOIN nodes n ON s.definition_node_id = n.id
      JOIN files f ON n.file_id = f.id
      WHERE s.name = ?
    `).all(symbolName) as Array<{ id: number; name: string; kind: string; path: string; source: string; start: number; end: number }>;
    
    if (symbols.length === 0) {
      return { success: false, error: `Symbol '${symbolName}' not found in graph` };
    }
    
    const symbol = symbols[0]!;
    
    let newCode: string;
    if (typeof fn === 'function') {
      newCode = fn.toString();
    } else {
      newCode = `class ${symbolName} {}`;
    }
    
    const newSource = symbol.source.substring(0, symbol.start) + newCode + symbol.source.substring(symbol.end);
    
    db.prepare(`
      UPDATE files SET source = ? WHERE path = ?
    `).run(newSource, symbol.path);
    
    db.prepare(`
      UPDATE symbols SET version = version + 1 WHERE name = ?
    `).run(symbolName);
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
