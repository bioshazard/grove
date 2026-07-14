import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDatabase, type Database } from "../src/db.ts";
import {
  findReferences,
  indexWorkspace,
  readSymbolSource,
  searchSymbols,
  type SemanticSymbol,
} from "../src/semantic-index.ts";

describe("compiler-backed semantic index", () => {
  let root: string;
  let database: Database;
  let exportedRun: SemanticSymbol;

  beforeEach(async () => {
    root = mkdtempSync(resolve(tmpdir(), "grove-index-"));
    writeFileSync(resolve(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { moduleResolution: "bundler", module: "preserve", strict: true },
    }));
    writeFileSync(resolve(root, "a.ts"), [
      "export function run(value: number) { return value + 1; }",
      "export const normalize = (value: number) => run(value);",
      "",
    ].join("\n"));
    writeFileSync(resolve(root, "b.ts"), [
      'import { run as execute, normalize } from "./a";',
      'export function run(value: string) { return value.toUpperCase(); }',
      "export const result = execute(1) + normalize(2) + run('local');",
      "",
    ].join("\n"));
    writeFileSync(resolve(root, "facets.ts"), [
      "export interface Pair { value: number }",
      "export const Pair = (value: number): Pair => ({ value });",
      "export type PairAlias = Pair;",
      "export const pair = Pair(1);",
      "",
    ].join("\n"));
    database = await createDatabase(resolve(root, "index.db"));
    indexWorkspace(database, root, [resolve(root, "a.ts"), resolve(root, "b.ts"), resolve(root, "facets.ts")]);
    exportedRun = searchSymbols(database, "run").find((symbol) => symbol.filePath === "a.ts")!;
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps same-name symbols distinct and resolves aliases", () => {
    const runs = searchSymbols(database, "run");
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((symbol) => symbol.id)).size).toBe(2);

    const references = findReferences(database, exportedRun.id);
    expect(references.map((reference) => `${reference.filePath}:${reference.line}`)).toEqual([
      "a.ts:2",
      "b.ts:1",
      "b.ts:1",
      "b.ts:3",
    ]);
    expect(references.some((reference) => reference.filePath === "b.ts" && reference.line === 2)).toBe(false);
  });

  it("indexes arrow-function variables", () => {
    const normalize = searchSymbols(database, "normalize");
    expect(normalize).toHaveLength(1);
    expect(findReferences(database, normalize[0]!.id).map((reference) => reference.line)).toEqual([1, 3]);
  });

  it("reads authoritative source from disk and keeps IDs stable", () => {
    expect(readSymbolSource(root, exportedRun)).toContain("function run");
    const id = exportedRun.id;
    indexWorkspace(database, root, [resolve(root, "a.ts"), resolve(root, "b.ts"), resolve(root, "facets.ts")]);
    expect(searchSymbols(database, "run").find((symbol) => symbol.filePath === "a.ts")!.id).toBe(id);

    const fileColumns = database.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    expect(fileColumns.map((column) => column.name)).not.toContain("source");
    expect(readFileSync(resolve(root, "a.ts"), "utf8")).toContain("value + 1");
  });

  it("separates merged type and value facets", () => {
    const pairs = searchSymbols(database, "Pair");
    expect(pairs).toHaveLength(2);
    const typeFacet = pairs.find((pair) => pair.kind === "InterfaceDeclaration")!;
    const valueFacet = pairs.find((pair) => pair.kind === "VariableDeclaration")!;
    expect(findReferences(database, typeFacet.id).map((reference) => reference.line)).toEqual([2, 3]);
    expect(findReferences(database, valueFacet.id).map((reference) => reference.line)).toEqual([4]);
  });
});
