import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createDatabase, type Database } from './src/db.js';
import { 
  hydrateSource, 
  symbolQuery, 
  getAllSymbols, 
  findCallers,
  materialize,
  getSymbolWithReferences,
  insertTraces,
  queryTraces,
  resolveSymbolId,
  joinTracesWithSymbols,
  findSlowTracesWithSymbols,
  type TraceSpan
} from './src/parser.js';
import { evalCode, evalSymbol, evalExpression, insertCapturedTraces, createReplSession, loadSymbolsIntoRepl, replCallSymbol, replUpdateSymbol, replWriteback, type ReplSession } from './src/repl.js';
import { swarm, findSwarmTargets, type SwarmTransformation } from './src/swarm.js';
import fs from 'fs';
import path from 'path';

let db: Database | null = null;
const DB_PATH = '/tmp/grove-mcp.db';

let replSession: ReplSession | null = null;

async function getDb(): Promise<Database> {
  if (!db) {
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
    }
    db = await createDatabase(DB_PATH);
  }
  return db;
}

function getReplSession(): ReplSession {
  if (!replSession) {
    replSession = createReplSession({ sandbox: true, timeout: 5000 });
  }
  return replSession;
}

const server = new Server(
  {
    name: 'grove-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'session_init',
        description: 'Initialize a session by hydrating a file or directory into the graph',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory path to hydrate' },
          },
          required: ['path'],
        },
      },
      {
        name: 'symbol_query',
        description: 'Query a symbol by name to get its definition and metadata',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Symbol name to query' },
          },
          required: ['name'],
        },
      },
      {
        name: 'find_callers',
        description: 'Find all callers/references of a symbol',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Symbol name to find callers for' },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_all_symbols',
        description: 'Get all symbols in the graph',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'hydrate_source',
        description: 'Add or update a source file in the graph',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'File path' },
            source: { type: 'string', description: 'Source code content' },
          },
          required: ['filePath', 'source'],
        },
      },
      {
        name: 'materialize',
        description: 'Materialize a file from the graph back to source text',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'File path to materialize' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'trace_query',
        description: 'Query traces in the database',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SQL query to execute' },
          },
          required: ['sql'],
        },
      },
      {
        name: 'get_symbol_with_references',
        description: 'Get a symbol with all its references across files',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Symbol name to query' },
          },
          required: ['name'],
        },
      },
      {
        name: 'insert_traces',
        description: 'Insert OTel trace spans into the database',
        inputSchema: {
          type: 'object',
          properties: {
            spans: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  spanId: { type: 'string' },
                  parentSpanId: { type: 'string' },
                  name: { type: 'string' },
                  startTime: { type: 'number' },
                  endTime: { type: 'number' },
                  attributes: { type: 'object' },
                },
                required: ['spanId', 'name', 'startTime', 'endTime'],
              },
            },
          },
          required: ['spans'],
        },
      },
      {
        name: 'trace_query',
        description: 'Query traces using SQL',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SQL query to execute' },
          },
          required: ['sql'],
        },
      },
      {
        name: 'resolve_symbol_id',
        description: 'Resolve a symbol name to its ID for linking traces to code',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Symbol name to resolve' },
          },
          required: ['name'],
        },
      },
      {
        name: 'join_traces_with_symbols',
        description: 'Join trace data with symbol graph - find slow functions, aggregate by symbol',
        inputSchema: {
          type: 'object',
          properties: {
            minDurationMs: { type: 'number', description: 'Minimum duration in ms to filter traces' },
          },
          required: [],
        },
      },
      {
        name: 'find_slow_traces_with_symbols',
        description: 'Find slow traces with their associated symbol information',
        inputSchema: {
          type: 'object',
          properties: {
            minDurationMs: { type: 'number', description: 'Minimum duration in ms' },
            limit: { type: 'number', description: 'Maximum results to return' },
          },
          required: ['minDurationMs'],
        },
      },
      {
        name: 'eval_code',
        description: 'Execute arbitrary code in a sandboxed environment with optional trace capture',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'JavaScript/TypeScript code to execute' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default: 5000)' },
            captureTraces: { type: 'boolean', description: 'Whether to capture execution traces' },
          },
          required: ['code'],
        },
      },
      {
        name: 'eval_symbol',
        description: 'Evaluate a symbol (function) by name with given arguments',
        inputSchema: {
          type: 'object',
          properties: {
            symbolName: { type: 'string', description: 'Name of the symbol to evaluate' },
            args: { type: 'array', description: 'Arguments to pass to the symbol' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default: 5000)' },
            captureTraces: { type: 'boolean', description: 'Whether to capture execution traces' },
          },
          required: ['symbolName'],
        },
      },
      {
        name: 'eval_expression',
        description: 'Evaluate an expression with optional context variables',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Expression to evaluate' },
            context: { type: 'object', description: 'Context variables available during evaluation' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default: 5000)' },
            captureTraces: { type: 'boolean', description: 'Whether to capture execution traces' },
          },
          required: ['expression'],
        },
      },
      {
        name: 'insert_captured_traces',
        description: 'Insert captured trace spans into the database',
        inputSchema: {
          type: 'object',
          properties: {
            spans: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  spanId: { type: 'string' },
                  parentSpanId: { type: 'string' },
                  name: { type: 'string' },
                  startTime: { type: 'number' },
                  endTime: { type: 'number' },
                  attributes: { type: 'object' },
                  symbolId: { type: 'number' },
                },
                required: ['spanId', 'name', 'startTime', 'endTime'],
              },
            },
          },
          required: ['spans'],
        },
      },
      {
        name: 'repl_create_session',
        description: 'Create a new REPL session for live development',
        inputSchema: {
          type: 'object',
          properties: {
            sandbox: { type: 'boolean', description: 'Run in sandboxed mode (default: true)' },
            timeout: { type: 'number', description: 'Default timeout in ms (default: 5000)' },
          },
          required: [],
        },
      },
      {
        name: 'repl_load_symbols',
        description: 'Load all symbols from the graph into the REPL session context',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'repl_call_symbol',
        description: 'Call a symbol (function) by name with given arguments in the REPL session',
        inputSchema: {
          type: 'object',
          properties: {
            symbolName: { type: 'string', description: 'Name of the symbol to call' },
            args: { type: 'array', description: 'Arguments to pass to the symbol' },
            captureTraces: { type: 'boolean', description: 'Capture execution traces' },
          },
          required: ['symbolName'],
        },
      },
      {
        name: 'repl_update_symbol',
        description: 'Update a symbol in the REPL session with new code (live redefinition)',
        inputSchema: {
          type: 'object',
          properties: {
            symbolName: { type: 'string', description: 'Name of the symbol to update' },
            newCode: { type: 'string', description: 'New source code for the symbol' },
          },
          required: ['symbolName', 'newCode'],
        },
      },
      {
        name: 'repl_writeback',
        description: 'Write a modified symbol from REPL back to the graph (commit)',
        inputSchema: {
          type: 'object',
          properties: {
            symbolName: { type: 'string', description: 'Name of the symbol to write back' },
          },
          required: ['symbolName'],
        },
      },
      {
        name: 'swarm_find_targets',
        description: 'Find all targets matching swarm criteria (dry run)',
        inputSchema: {
          type: 'object',
          properties: {
            nodeKinds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Node kinds to match (e.g., FunctionDeclaration)',
            },
            filePattern: {
              type: 'string',
              description: 'Regex pattern for file paths',
            },
          },
          required: [],
        },
      },
      {
        name: 'swarm_execute',
        description: 'Execute a transformation across multiple files atomically (Phase 5)',
        inputSchema: {
          type: 'object',
          properties: {
            transformPattern: {
              type: 'string',
              description: 'Regex pattern to match in source code',
            },
            transformReplacement: {
              type: 'string',
              description: 'Replacement string (supports $1, $2, etc. for capture groups)',
            },
            nodeKinds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Node kinds to limit transformation to',
            },
            filePattern: {
              type: 'string',
              description: 'Regex pattern for file paths to transform',
            },
            dryRun: {
              type: 'boolean',
              description: 'If true, only find targets without modifying',
            },
            trackVersions: {
              type: 'boolean',
              description: 'Track symbol version changes',
            },
          },
          required: ['transformPattern', 'transformReplacement'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'session_init': {
        const db = await getDb();
        const targetPath = (args as { path: string }).path;
        
        if (fs.statSync(targetPath).isDirectory()) {
          const files = fs.readdirSync(targetPath).filter(f => f.endsWith('.ts'));
          for (const file of files) {
            const fullPath = path.join(targetPath, file);
            const source = fs.readFileSync(fullPath, 'utf-8');
            hydrateSource(db, fullPath, source);
          }
        } else {
          const source = fs.readFileSync(targetPath, 'utf-8');
          hydrateSource(db, targetPath, source);
        }
        
        return {
          content: [
            { type: 'text', text: `Session initialized with ${targetPath}` }
          ],
        };
      }

      case 'symbol_query': {
        const db = await getDb();
        const results = symbolQuery(db, (args as { name: string }).name);
        return {
          content: [
            { type: 'text', text: JSON.stringify(results, null, 2) }
          ],
        };
      }

      case 'find_callers': {
        const db = await getDb();
        const results = findCallers(db, (args as { name: string }).name);
        return {
          content: [
            { type: 'text', text: JSON.stringify(results, null, 2) }
          ],
        };
      }

      case 'get_all_symbols': {
        const db = await getDb();
        const results = getAllSymbols(db);
        return {
          content: [
            { type: 'text', text: JSON.stringify(results, null, 2) }
          ],
        };
      }

      case 'hydrate_source': {
        const db = await getDb();
        const { filePath, source } = args as { filePath: string; source: string };
        const fileId = hydrateSource(db, filePath, source);
        return {
          content: [
            { type: 'text', text: `Hydrated ${filePath} with fileId ${fileId}` }
          ],
        };
      }

      case 'materialize': {
        const db = await getDb();
        const { filePath } = args as { filePath: string };
        const source = materialize(db, filePath);
        return {
          content: [
            { type: 'text', text: source }
          ],
        };
      }

      case 'trace_query': {
        const db = await getDb();
        const { sql } = args as { sql: string };
        const results = db.prepare(sql).all();
        return {
          content: [
            { type: 'text', text: JSON.stringify(results, null, 2) }
          ],
        };
      }

      case 'get_symbol_with_references': {
        const db = await getDb();
        const { name } = args as { name: string };
        const result = getSymbolWithReferences(db, name);
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'insert_traces': {
        const db = await getDb();
        const { spans } = args as { spans: TraceSpan[] };
        // Auto-resolve symbol_id from span name when not provided
        const linkedSpans = spans.map(span => {
          if (span.symbolId == null) {
            const symbolId = resolveSymbolId(db, span.name);
            return symbolId != null ? { ...span, symbolId } : span;
          }
          return span;
        });
        const ids = insertTraces(db, linkedSpans);
        return {
          content: [
            { type: 'text', text: `Inserted ${ids.length} trace spans with IDs: ${JSON.stringify(ids)}` }
          ],
        };
      }

      case 'trace_query': {
        const db = await getDb();
        const { sql } = args as { sql: string };
        const results = queryTraces(db, sql);
        return {
          content: [
            { type: 'text', text: JSON.stringify(results, null, 2) }
          ],
        };
      }

      case 'resolve_symbol_id': {
        const db = await getDb();
        const { name } = args as { name: string };
        const symbolId = resolveSymbolId(db, name);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ symbolName: name, symbolId }, null, 2) }
          ],
        };
      }

      case 'join_traces_with_symbols': {
        const db = await getDb();
        const { minDurationMs } = args as { minDurationMs?: number };
        const results = joinTracesWithSymbols(db, minDurationMs);
        return {
          content: [
            { type: 'text', text: JSON.stringify(results, null, 2) }
          ],
        };
      }

      case 'find_slow_traces_with_symbols': {
        const db = await getDb();
        const { minDurationMs, limit = 100 } = args as { minDurationMs: number; limit?: number };
        const results = findSlowTracesWithSymbols(db, minDurationMs, limit);
        return {
          content: [
            { type: 'text', text: JSON.stringify(results, null, 2) }
          ],
        };
      }

      case 'eval_code': {
        const db = await getDb();
        const { code, timeout, captureTraces } = args as { code: string; timeout?: number; captureTraces?: boolean };
        const result = evalCode(db, code, { timeout, sandbox: true, captureTraces });
        if (result.traces && result.traces.length > 0) {
          insertCapturedTraces(db, result.traces);
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'eval_symbol': {
        const db = await getDb();
        const { symbolName, args: symbolArgs, timeout, captureTraces } = args as { symbolName: string; args?: unknown[]; timeout?: number; captureTraces?: boolean };
        const result = evalSymbol(db, symbolName, symbolArgs || [], { timeout, sandbox: true, captureTraces });
        if (result.traces && result.traces.length > 0) {
          insertCapturedTraces(db, result.traces);
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'eval_expression': {
        const db = await getDb();
        const { expression, context, timeout, captureTraces } = args as { expression: string; context?: Record<string, unknown>; timeout?: number; captureTraces?: boolean };
        const result = evalExpression(db, expression, context, { timeout, sandbox: true, captureTraces });
        if (result.traces && result.traces.length > 0) {
          insertCapturedTraces(db, result.traces);
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'insert_captured_traces': {
        const db = await getDb();
        const { spans } = args as { spans: Array<{ spanId: string; parentSpanId?: string | null; name: string; startTime: number; endTime: number; attributes?: Record<string, unknown>; symbolId?: number }> };
        const normalizedSpans = spans.map(s => ({
          spanId: s.spanId,
          parentSpanId: s.parentSpanId ?? null,
          name: s.name,
          startTime: s.startTime,
          endTime: s.endTime,
          attributes: s.attributes || {},
          symbolId: s.symbolId,
        }));
        const ids = insertCapturedTraces(db, normalizedSpans);
        return {
          content: [
            { type: 'text', text: `Inserted ${ids.length} trace spans with IDs: ${JSON.stringify(ids)}` }
          ],
        };
      }

      case 'repl_create_session': {
        const { sandbox, timeout } = args as { sandbox?: boolean; timeout?: number };
        replSession = createReplSession({ sandbox: sandbox ?? true, timeout });
        return {
          content: [
            { type: 'text', text: 'REPL session created' }
          ],
        };
      }

      case 'repl_load_symbols': {
        const db = await getDb();
        const session = getReplSession();
        const result = loadSymbolsIntoRepl(db, session);
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'repl_call_symbol': {
        const db = await getDb();
        const { symbolName, args: symbolArgs, captureTraces } = args as { symbolName: string; args?: unknown[]; captureTraces?: boolean };
        const session = getReplSession();
        const result = replCallSymbol(db, session, symbolName, symbolArgs || [], { captureTraces });
        if (result.traces && result.traces.length > 0) {
          insertCapturedTraces(db, result.traces);
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'repl_update_symbol': {
        const { symbolName, newCode } = args as { symbolName: string; newCode: string };
        const session = getReplSession();
        const result = replUpdateSymbol(session, symbolName, newCode);
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'repl_writeback': {
        const db = await getDb();
        const { symbolName } = args as { symbolName: string };
        const session = getReplSession();
        const result = replWriteback(db, session, symbolName);
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      case 'swarm_find_targets': {
        const db = await getDb();
        const { nodeKinds, filePattern } = args as { nodeKinds?: string[]; filePattern?: string };
        
        const transformation: SwarmTransformation = {
          transform: (s) => s, // No-op for find targets
          nodeKinds,
          filePattern: filePattern ? new RegExp(filePattern) : undefined,
        };
        
        const targets = findSwarmTargets(db, transformation);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ targets, count: targets.length }, null, 2) }
          ],
        };
      }

      case 'swarm_execute': {
        const db = await getDb();
        const { transformPattern, transformReplacement, nodeKinds, filePattern, dryRun, trackVersions } = args as {
          transformPattern: string;
          transformReplacement: string;
          nodeKinds?: string[];
          filePattern?: string;
          dryRun?: boolean;
          trackVersions?: boolean;
        };
        
        const transformation: SwarmTransformation = {
          transform: (source: string) => {
            const regex = new RegExp(transformPattern, 'g');
            return source.replace(regex, transformReplacement);
          },
          nodeKinds,
          filePattern: filePattern ? new RegExp(filePattern) : undefined,
        };
        
        const result = swarm(db, transformation, { dryRun, trackVersions });
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) }
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        { type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
