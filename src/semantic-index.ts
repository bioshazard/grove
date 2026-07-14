import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Node, Project, SyntaxKind, type Identifier, type Symbol as MorphSymbol } from "ts-morph";
import type { Database } from "./db.ts";

export interface SemanticSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  start: number;
  end: number;
  line: number;
  column: number;
  exported: boolean;
}

export interface SemanticReference {
  symbolId: string;
  filePath: string;
  start: number;
  end: number;
  line: number;
  column: number;
  isDefinition: boolean;
}

export interface IndexResult {
  files: number;
  symbols: number;
  references: number;
  durationMs: number;
}

interface SymbolDraft {
  compilerSymbol: MorphSymbol;
  names: Identifier[];
  symbol: SemanticSymbol;
}

type SymbolFacet = "type" | "value";

export function discoverTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const excluded = new Set([".git", ".grove", "node_modules", "dist", "build", "coverage"]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) visit(resolve(directory, entry.name));
      } else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(resolve(directory, entry.name));
      }
    }
  };
  visit(resolve(root));
  return files.sort();
}

export function indexWorkspace(db: Database, root: string, paths = discoverTypeScriptFiles(root)): IndexResult {
  const started = performance.now();
  const workspaceRoot = resolve(root);
  const selected = new Set(paths.map((path) => resolve(path)));
  const tsconfig = resolve(workspaceRoot, "tsconfig.json");
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ skipAddingFilesFromTsConfig: true });

  for (const path of selected) project.addSourceFileAtPath(path);
  project.resolveSourceFileDependencies();

  const sourceFiles = project.getSourceFiles().filter((file) => selected.has(resolve(file.getFilePath())));
  const traceLinks = db.prepare(
    "SELECT span_id AS spanId, symbol_id AS symbolId FROM traces WHERE symbol_id IS NOT NULL",
  ).all() as Array<{ spanId: string; symbolId: string }>;
  const draftsByCompilerSymbol = new Map<unknown, Map<SymbolFacet, SymbolDraft>>();
  const draftByDefinition = new Map<Identifier, SymbolDraft>();

  for (const sourceFile of sourceFiles) {
    for (const nameNode of declarationNames(sourceFile.getDescendants().filter(Node.isIdentifier))) {
      const compilerSymbol = nameNode.getSymbol();
      if (!compilerSymbol) continue;
      const key = compilerSymbol.compilerSymbol;
      const facet = facetForDeclaration(nameNode.getParentOrThrow());
      const facets = draftsByCompilerSymbol.get(key) ?? new Map<SymbolFacet, SymbolDraft>();
      draftsByCompilerSymbol.set(key, facets);
      const existing = facets.get(facet);
      if (existing) {
        existing.names.push(nameNode);
        draftByDefinition.set(nameNode, existing);
        continue;
      }
      const draft = {
        compilerSymbol,
        names: [nameNode],
        symbol: symbolFromDeclaration(workspaceRoot, compilerSymbol, nameNode, facet),
      };
      facets.set(facet, draft);
      draftByDefinition.set(nameNode, draft);
    }
  }

  const references: SemanticReference[] = [];
  const seen = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
      let compilerSymbol = identifier.getSymbol();
      if (!compilerSymbol) continue;
      if (compilerSymbol.isAlias()) {
        try {
          compilerSymbol = compilerSymbol.getAliasedSymbol() ?? compilerSymbol;
        } catch {
          continue;
        }
      }
      const facets = draftsByCompilerSymbol.get(compilerSymbol.compilerSymbol);
      const draft = draftByDefinition.get(identifier) ?? selectFacet(facets, identifier);
      if (!draft) continue;
      const filePath = normalizePath(relative(workspaceRoot, identifier.getSourceFile().getFilePath()));
      const reference: SemanticReference = {
        symbolId: draft.symbol.id,
        filePath,
        start: identifier.getStart(),
        end: identifier.getEnd(),
        line: identifier.getStartLineNumber(),
        column: identifier.getStart() - identifier.getStartLinePos() + 1,
        isDefinition: draftByDefinition.has(identifier),
      };
      const referenceKey = `${reference.symbolId}:${filePath}:${reference.start}:${reference.end}`;
      if (!seen.has(referenceKey)) {
        seen.add(referenceKey);
        references.push(reference);
      }
    }
  }

  const fileIds = new Map<string, number>();
  db.transaction(() => {
    db.exec("DELETE FROM symbol_references; DELETE FROM symbols; DELETE FROM files;");
    for (const sourceFile of sourceFiles) {
      const absolutePath = sourceFile.getFilePath();
      const filePath = normalizePath(relative(workspaceRoot, absolutePath));
      const result = db.run(
        "INSERT INTO files(path, content_hash, indexed_at) VALUES (?, ?, ?)",
        filePath,
        hash(readFileSync(absolutePath, "utf8")),
        Date.now(),
      );
      fileIds.set(filePath, result.lastInsertRowid);
    }
    const drafts = [...draftsByCompilerSymbol.values()].flatMap((facets) => [...facets.values()]);
    for (const { symbol } of drafts) {
      db.run(
        `INSERT INTO symbols(id, name, kind, file_id, start, end, line, column_number, exported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        symbol.id,
        symbol.name,
        symbol.kind,
        required(fileIds.get(symbol.filePath), `Missing file ${symbol.filePath}`),
        symbol.start,
        symbol.end,
        symbol.line,
        symbol.column,
        symbol.exported ? 1 : 0,
      );
    }
    for (const reference of references) {
      db.run(
        `INSERT INTO symbol_references(symbol_id, file_id, start, end, line, column_number, is_definition)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        reference.symbolId,
        required(fileIds.get(reference.filePath), `Missing file ${reference.filePath}`),
        reference.start,
        reference.end,
        reference.line,
        reference.column,
        reference.isDefinition ? 1 : 0,
      );
    }
    for (const link of traceLinks) {
      db.run(
        "UPDATE traces SET symbol_id = ? WHERE span_id = ? AND EXISTS (SELECT 1 FROM symbols WHERE id = ?)",
        link.symbolId,
        link.spanId,
        link.symbolId,
      );
    }
  });

  return {
    files: sourceFiles.length,
    symbols: [...draftsByCompilerSymbol.values()].reduce((count, facets) => count + facets.size, 0),
    references: references.length,
    durationMs: performance.now() - started,
  };
}

export function searchSymbols(db: Database, name: string): SemanticSymbol[] {
  return db.prepare(
    `SELECT s.id, s.name, s.kind, f.path AS filePath, s.start, s.end, s.line,
            s.column_number AS column, s.exported
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.name = ? ORDER BY f.path, s.start`,
  ).all(name).map(toSymbol);
}

export function getSymbol(db: Database, id: string): SemanticSymbol | undefined {
  const row = db.prepare(
    `SELECT s.id, s.name, s.kind, f.path AS filePath, s.start, s.end, s.line,
            s.column_number AS column, s.exported
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  ).get(id);
  return row ? toSymbol(row) : undefined;
}

export function findSymbolAt(db: Database, filePath: string, line: number, name?: string): SemanticSymbol | undefined {
  const row = db.prepare(
    `SELECT s.id, s.name, s.kind, sf.path AS filePath, s.start, s.end, s.line,
            s.column_number AS column, s.exported
     FROM symbol_references r
     JOIN symbols s ON s.id = r.symbol_id
     JOIN files rf ON rf.id = r.file_id
     JOIN files sf ON sf.id = s.file_id
     WHERE rf.path = ? AND r.line = ? AND r.is_definition = 1
       AND (? IS NULL OR s.name = ?) LIMIT 1`,
  ).get(normalizePath(filePath), line, name ?? null, name ?? null);
  return row ? toSymbol(row) : undefined;
}

export function findReferences(db: Database, symbolId: string, includeDefinitions = false): SemanticReference[] {
  return db.prepare(
    `SELECT r.symbol_id AS symbolId, f.path AS filePath, r.start, r.end, r.line,
            r.column_number AS column, r.is_definition AS isDefinition
     FROM symbol_references r JOIN files f ON f.id = r.file_id
     WHERE r.symbol_id = ? AND (? = 1 OR r.is_definition = 0)
     ORDER BY f.path, r.start`,
  ).all(symbolId, includeDefinitions ? 1 : 0).map((value) => {
    const row = value as Record<string, unknown>;
    return { ...row, isDefinition: Boolean(row.isDefinition) } as unknown as SemanticReference;
  });
}

export function readSymbolSource(root: string, symbol: SemanticSymbol): string {
  return readFileSync(resolve(root, symbol.filePath), "utf8").slice(symbol.start, symbol.end);
}

function declarationNames(identifiers: Identifier[]): Identifier[] {
  return identifiers.filter((identifier) => {
    const parent = identifier.getParent();
    if (!parent) return false;
    if (
      Node.isFunctionDeclaration(parent) || Node.isClassDeclaration(parent) ||
      Node.isInterfaceDeclaration(parent) || Node.isTypeAliasDeclaration(parent) ||
      Node.isEnumDeclaration(parent)
    ) {
      return parent.getNameNode() === identifier && isModuleDeclaration(parent.getParent());
    }
    if (Node.isVariableDeclaration(parent)) {
      const statement = parent.getVariableStatement();
      return parent.getNameNode() === identifier && Boolean(statement && isModuleDeclaration(statement.getParent()));
    }
    if (
      Node.isMethodDeclaration(parent) || Node.isPropertyDeclaration(parent) ||
      Node.isGetAccessorDeclaration(parent) || Node.isSetAccessorDeclaration(parent)
    ) {
      const container = parent.getParent();
      return parent.getNameNode() === identifier &&
        (Node.isClassDeclaration(container) || Node.isInterfaceDeclaration(container) || Node.isTypeLiteral(container));
    }
    if (Node.isEnumMember(parent)) return parent.getNameNode() === identifier;
    return false;
  });
}

function isModuleDeclaration(node: Node | undefined): boolean {
  return Boolean(node && (Node.isSourceFile(node) || Node.isModuleBlock(node)));
}

function symbolFromDeclaration(
  root: string,
  compilerSymbol: MorphSymbol,
  nameNode: Identifier,
  facet: SymbolFacet,
): SemanticSymbol {
  const declaration = nameNode.getParentOrThrow();
  const filePath = normalizePath(relative(root, nameNode.getSourceFile().getFilePath()));
  const kind = declaration.getKindName();
  const qualifiedName = normalizePath(compilerSymbol.getFullyQualifiedName()).replace(normalizePath(root), "<root>");
  const id = hash(`${filePath}\0${qualifiedName}\0${facet}\0${kind}`);
  return {
    id,
    name: nameNode.getText(),
    kind,
    filePath,
    start: declaration.getStart(),
    end: declaration.getEnd(),
    line: nameNode.getStartLineNumber(),
    column: nameNode.getStart() - nameNode.getStartLinePos() + 1,
    exported: isExported(declaration),
  };
}

function facetForDeclaration(node: Node): SymbolFacet {
  return Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node) ? "type" : "value";
}

function selectFacet(facets: Map<SymbolFacet, SymbolDraft> | undefined, identifier: Identifier): SymbolDraft | undefined {
  if (!facets || facets.size === 0) return undefined;
  if (facets.size === 1) return facets.values().next().value;
  return facets.get(isTypePosition(identifier) ? "type" : "value");
}

function isTypePosition(identifier: Identifier): boolean {
  let current: Node | undefined = identifier.getParent();
  while (current) {
    if (Node.isTypeQuery(current)) return false;
    if (Node.isTypeNode(current)) return true;
    if (Node.isExpression(current) || Node.isStatement(current) || Node.isSourceFile(current)) return false;
    current = current.getParent();
  }
  return false;
}

function isExported(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isExportable(current) && current.isExported()) return true;
    current = current.getParent();
  }
  return false;
}

function toSymbol(value: unknown): SemanticSymbol {
  const row = value as Record<string, unknown>;
  return { ...row, exported: Boolean(row.exported) } as unknown as SemanticSymbol;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
