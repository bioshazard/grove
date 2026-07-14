import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createDatabase, type Database } from "./src/db.ts";
import {
  discoverTypeScriptFiles,
  findReferences,
  getSymbol,
  hash,
  indexWorkspace,
  readSymbolSource,
  searchSymbols,
} from "./src/semantic-index.ts";
import { insertTraces, queryTraces, tracesForSymbol, type TraceSpan } from "./src/traces.ts";
import { WorkspaceSession } from "./src/workspace.ts";

let database: Database | undefined;
let root: string | undefined;
let workspace: WorkspaceSession | undefined;

const server = new Server(
  { name: "grove", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    tool("workspace_index", "Index a TypeScript workspace using compiler semantics", {
      path: stringProperty("Workspace root; defaults to the current directory"),
    }),
    tool("symbol_search", "Find distinct semantic symbols by name", {
      name: stringProperty("Exact symbol name"),
    }, ["name"]),
    tool("symbol_get", "Get one symbol, its exact source, references, and linked traces", {
      symbolId: stringProperty("Stable semantic symbol ID"),
    }, ["symbolId"]),
    tool("symbol_references", "Find compiler-resolved references to one symbol", {
      symbolId: stringProperty("Stable semantic symbol ID"),
      includeDefinitions: { type: "boolean" },
    }, ["symbolId"]),
    tool("edit_stage_replace", "Stage replacement of one complete declaration", {
      symbolId: stringProperty("Stable semantic symbol ID"),
      source: stringProperty("Complete replacement declaration"),
    }, ["symbolId", "source"]),
    tool("edit_preview", "Preview all staged files", {}),
    tool("edit_commit", "Validate hashes and transactionally commit staged files", {}),
    tool("edit_discard", "Discard all staged changes", {}),
    tool("trace_insert", "Insert runtime spans linked to semantic symbol IDs", {
      spans: { type: "array", items: { type: "object" } },
    }, ["spans"]),
    tool("trace_query", "Run a read-only SQL query over indexed traces and symbols", {
      sql: stringProperty("SELECT or WITH query"),
      params: { type: "array" },
    }, ["sql"]),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  try {
    switch (request.params.name) {
      case "workspace_index": {
        root = resolve(String(args.path ?? process.cwd()));
        database?.close();
        database = await createDatabase(`${tmpdir()}/grove-${hash(root)}.db`);
        const result = indexWorkspace(database, root, discoverTypeScriptFiles(root));
        workspace = new WorkspaceSession(database, root);
        return response({ root, ...result });
      }
      case "symbol_search":
        return response(searchSymbols(requiredDatabase(), String(args.name)));
      case "symbol_get": {
        const symbol = getSymbol(requiredDatabase(), String(args.symbolId));
        if (!symbol) throw new Error("Symbol not found");
        return response({
          ...symbol,
          source: readSymbolSource(requiredRoot(), symbol),
          references: findReferences(requiredDatabase(), symbol.id),
          traces: tracesForSymbol(requiredDatabase(), symbol.id),
        });
      }
      case "symbol_references":
        return response(findReferences(
          requiredDatabase(),
          String(args.symbolId),
          Boolean(args.includeDefinitions),
        ));
      case "edit_stage_replace":
        requiredWorkspace().stageReplace(String(args.symbolId), String(args.source));
        return response(requiredWorkspace().preview());
      case "edit_preview":
        return response(requiredWorkspace().preview());
      case "edit_commit": {
        const files = requiredWorkspace().commit();
        const result = indexWorkspace(requiredDatabase(), requiredRoot(), discoverTypeScriptFiles(requiredRoot()));
        return response({ files, reindexed: result });
      }
      case "edit_discard":
        requiredWorkspace().discard();
        return response({ discarded: true });
      case "trace_insert":
        insertTraces(requiredDatabase(), args.spans as unknown as TraceSpan[]);
        return response({ inserted: (args.spans as unknown[]).length });
      case "trace_query":
        return response(queryTraces(requiredDatabase(), String(args.sql), (args.params as unknown[]) ?? []));
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
});

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required } };
}

function stringProperty(description: string) {
  return { type: "string", description };
}

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function requiredDatabase(): Database {
  if (!database) throw new Error("Call workspace_index first");
  return database;
}

function requiredRoot(): string {
  if (!root) throw new Error("Call workspace_index first");
  return root;
}

function requiredWorkspace(): WorkspaceSession {
  if (!workspace) throw new Error("Call workspace_index first");
  return workspace;
}

await server.connect(new StdioServerTransport());
