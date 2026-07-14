/**
 * RETRIEVAL REGRESSION BENCHMARK
 *
 * Question: does Grove's semantic retrieval beat lexical search on real Zod
 * navigation tasks, judged against TypeScript semantic references?
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Project, Node, SyntaxKind, type SourceFile } from "ts-morph";
import { createDatabase } from "../../src/db.ts";
import { findReferences, findSymbolAt, indexWorkspace } from "../../src/semantic-index.ts";

type Location = `${string}:${number}`;

interface Task {
  name: string;
  kind: "unique" | "duplicate";
  definitionFile: string;
  definitionLine: number;
  truth: Location[];
}

interface Score {
  precision: number;
  recall: number;
  latencyMs: number;
  payloadBytes: number;
  returned: number;
}

const checkout = process.env.ZOD_DIR ?? `${tmpdir()}/grove-zod-navigation-prototype`;
if (!existsSync(checkout)) {
  const clone = Bun.spawnSync([
    "git",
    "clone",
    "--depth",
    "1",
    "https://github.com/colinhacks/zod.git",
    checkout,
  ]);
  if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
}

const scope = resolve(checkout, "packages/zod/src/v4/core");
const git = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"]);
const commit = git.stdout.toString().trim();
const fileList = Bun.spawnSync([
  "rg",
  "--files",
  scope,
  "-g",
  "*.ts",
  "-g",
  "!**/tests/**",
  "-g",
  "!**/*.test.ts",
]).stdout.toString().trim().split("\n").filter(Boolean).sort();

const sources = fileList.map((absolutePath) => ({
  absolutePath,
  path: relative(scope, absolutePath),
  source: readFileSync(absolutePath, "utf8"),
}));
const loc = sources.reduce((sum, file) => sum + file.source.split("\n").length, 0);

console.log("Grove × Zod navigation experiment");
console.log(JSON.stringify({ commit, scope: "packages/zod/src/v4/core", files: sources.length, loc }, null, 2));

const semanticStarted = performance.now();
const project = new Project({
  compilerOptions: {
    allowJs: false,
    moduleResolution: 100,
    skipLibCheck: true,
    strict: true,
  },
  skipAddingFilesFromTsConfig: true,
});
for (const file of sources) project.addSourceFileAtPath(file.absolutePath);
project.resolveSourceFileDependencies();

const declarations = collectDeclarations(project.getSourceFiles().filter((file) => file.getFilePath().startsWith(scope)));
const nameCounts = new Map<string, number>();
for (const declaration of declarations) {
  nameCounts.set(declaration.getText(), (nameCounts.get(declaration.getText()) ?? 0) + 1);
}

const candidates = declarations.flatMap((declaration) => {
  const name = declaration.getText();
  let references: Node[];
  try {
    references = declaration.findReferencesAsNodes();
  } catch {
    return [];
  }
  const truth = unique(references
    .filter((node) => node.getSourceFile().getFilePath().startsWith(scope))
    .map((node) => location(scope, node)));
  if (truth.length < 2) return [];
  return [{
    name,
    kind: (nameCounts.get(name) ?? 0) > 1 ? "duplicate" as const : "unique" as const,
    definitionFile: relative(scope, declaration.getSourceFile().getFilePath()),
    definitionLine: declaration.getStartLineNumber(),
    truth,
  }];
});

const tasks: Task[] = [
  ...candidates.filter((task) => task.kind === "unique").sort(byReferenceCount).slice(0, 6),
  ...candidates.filter((task) => task.kind === "duplicate").sort(byReferenceCount).slice(0, 6),
];
const semanticMs = performance.now() - semanticStarted;

const dbPath = `${tmpdir()}/grove-zod-navigation-prototype.db`;
rmSync(dbPath, { force: true });
const db = await createDatabase(dbPath);
const indexResult = indexWorkspace(db, scope, fileList);
const counts = {
  symbols: (db.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count,
  references: (db.prepare("SELECT COUNT(*) AS count FROM symbol_references").get() as { count: number }).count,
};

const rows = tasks.map((task) => {
  const groveStarted = performance.now();
  const symbol = findSymbolAt(db, task.definitionFile, task.definitionLine, task.name);
  const groveLocations = symbol
    ? unique(findReferences(db, symbol.id).map((result) => `${result.filePath}:${result.line}` as Location))
    : [];
  const grove = score(task.truth, groveLocations, performance.now() - groveStarted);

  const lexicalStarted = performance.now();
  const lexicalRun = Bun.spawnSync([
    "rg",
    "--json",
    "--word-regexp",
    "--fixed-strings",
    task.name,
    scope,
    "-g",
    "*.ts",
    "-g",
    "!**/tests/**",
    "-g",
    "!**/*.test.ts",
  ]);
  const lexicalLocations = unique(lexicalRun.stdout.toString().trim().split("\n").filter(Boolean).flatMap((line) => {
    const event = JSON.parse(line) as { type: string; data?: { path?: { text: string }; line_number?: number } };
    if (event.type !== "match" || !event.data?.path?.text || !event.data.line_number) return [];
    return [`${relative(scope, event.data.path.text)}:${event.data.line_number}` as Location];
  })).filter((item) => item !== `${task.definitionFile}:${task.definitionLine}`);
  const lexical = score(task.truth, lexicalLocations, performance.now() - lexicalStarted);

  return { task, grove, lexical };
});

console.log("\nState");
console.log(JSON.stringify({ semanticGroundTruthMs: semanticMs, indexResult, ...counts, tasks: tasks.length }, null, 2));
console.table(rows.map(({ task, grove, lexical }) => ({
  symbol: task.name,
  identity: task.kind,
  truth: task.truth.length,
  "grove P": grove.precision.toFixed(2),
  "grove R": grove.recall.toFixed(2),
  "rg P": lexical.precision.toFixed(2),
  "rg R": lexical.recall.toFixed(2),
  "grove ms": grove.latencyMs.toFixed(2),
  "rg ms": lexical.latencyMs.toFixed(2),
  "grove bytes": grove.payloadBytes,
  "rg bytes": lexical.payloadBytes,
})));

const groveAverage = average(rows.map((row) => row.grove));
const lexicalAverage = average(rows.map((row) => row.lexical));
const verdict = indexResult.durationMs > 30_000
  ? "NO-GO: indexing exceeds the 30 second Phase 1 gate"
  : groveAverage.recall < 0.95 || groveAverage.precision < 0.95
    ? "NO-GO: Grove precision or recall is below its 95% Phase 1 gate"
    : groveAverage.precision <= lexicalAverage.precision
      ? "NO-GO: Grove adds no precision advantage over lexical search"
      : "PROVISIONAL GO: retrieval clears Phase 1; next run model-equivalence trial";

console.log("\nSummary");
console.log(JSON.stringify({ groveAverage, lexicalAverage, verdict }, null, 2));
db.close();
rmSync(dbPath, { force: true });

function collectDeclarations(files: SourceFile[]): import("ts-morph").Identifier[] {
  return files.flatMap((file) => file.getDescendantsOfKind(SyntaxKind.Identifier).filter((identifier) => {
    const parent = identifier.getParent();
    if (!parent) return false;
    if (Node.isFunctionDeclaration(parent) || Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent)) {
      return parent.getNameNode() === identifier;
    }
    if (Node.isVariableDeclaration(parent)) return parent.getNameNode() === identifier;
    return false;
  }));
}

function location(root: string, node: Node): Location {
  return `${relative(root, node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;
}

function score(truth: Location[], returned: Location[], latencyMs: number): Score {
  const expected = new Set(truth);
  const actual = new Set(returned);
  const hits = [...actual].filter((item) => expected.has(item)).length;
  return {
    precision: actual.size === 0 ? (expected.size === 0 ? 1 : 0) : hits / actual.size,
    recall: expected.size === 0 ? 1 : hits / expected.size,
    latencyMs,
    payloadBytes: Buffer.byteLength(JSON.stringify(returned)),
    returned: actual.size,
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function byReferenceCount(a: Task, b: Task): number {
  return b.truth.length - a.truth.length || a.name.localeCompare(b.name);
}

function average(scores: Score[]): Score {
  const count = scores.length || 1;
  return {
    precision: scores.reduce((sum, score) => sum + score.precision, 0) / count,
    recall: scores.reduce((sum, score) => sum + score.recall, 0) / count,
    latencyMs: scores.reduce((sum, score) => sum + score.latencyMs, 0) / count,
    payloadBytes: scores.reduce((sum, score) => sum + score.payloadBytes, 0) / count,
    returned: scores.reduce((sum, score) => sum + score.returned, 0) / count,
  };
}
