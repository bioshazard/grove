import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDatabase, type Database } from "../src/db.ts";
import { indexWorkspace, searchSymbols, type SemanticSymbol } from "../src/semantic-index.ts";
import { insertTraces, queryTraces, tracesForSymbol } from "../src/traces.ts";
import { WorkspaceSession } from "../src/workspace.ts";

describe("workspace transactions and traces", () => {
  let root: string;
  let database: Database;
  let symbol: SemanticSymbol;

  beforeEach(async () => {
    root = mkdtempSync(resolve(tmpdir(), "grove-workspace-"));
    writeFileSync(resolve(root, "value.ts"), "export function value() { return 1; }\n");
    database = await createDatabase(resolve(root, "index.db"));
    indexWorkspace(database, root, [resolve(root, "value.ts")]);
    symbol = searchSymbols(database, "value")[0]!;
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stages, previews, and commits complete declarations", () => {
    const workspace = new WorkspaceSession(database, root);
    workspace.stageReplace(symbol.id, "export function value() { return 2; }");
    expect(workspace.preview()[0]!.after).toContain("return 2");
    expect(workspace.commit()).toEqual(["value.ts"]);
    expect(readFileSync(resolve(root, "value.ts"), "utf8")).toContain("return 2");
  });

  it("rejects edits after the indexed file changes", () => {
    const workspace = new WorkspaceSession(database, root);
    workspace.stageReplace(symbol.id, "export function value() { return 2; }");
    writeFileSync(resolve(root, "value.ts"), "export function value() { return 3; }\n");
    expect(() => workspace.preview()).toThrow("changed since indexing");
  });

  it("joins traces to stable semantic IDs and rejects writes through query", () => {
    insertTraces(database, [{
      spanId: "span-1",
      name: "value",
      startTime: 100,
      endTime: 125,
      symbolId: symbol.id,
      attributes: { input: 1 },
    }]);
    expect(tracesForSymbol(database, symbol.id)).toMatchObject([{ durationMs: 25, attributes: { input: 1 } }]);
    indexWorkspace(database, root, [resolve(root, "value.ts")]);
    expect(tracesForSymbol(database, symbol.id)).toHaveLength(1);
    expect(queryTraces(database, "SELECT name FROM traces")).toEqual([{ name: "value" }]);
    expect(() => queryTraces(database, "DELETE FROM traces")).toThrow("read-only");
  });
});
