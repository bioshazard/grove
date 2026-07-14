import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { Database } from "./db.ts";
import { getSymbol, hash, type SemanticSymbol } from "./semantic-index.ts";

interface Edit {
  symbol: SemanticSymbol;
  replacement: string;
}

export interface PreviewFile {
  filePath: string;
  before: string;
  after: string;
}

export class WorkspaceSession {
  private readonly edits = new Map<string, Edit>();

  constructor(private readonly db: Database, private readonly root: string) {}

  stageReplace(symbolId: string, replacement: string): void {
    const symbol = getSymbol(this.db, symbolId);
    if (!symbol) throw new Error(`Unknown symbol: ${symbolId}`);
    this.edits.set(symbolId, { symbol, replacement });
    this.preview();
  }

  discard(): void {
    this.edits.clear();
  }

  preview(): PreviewFile[] {
    const editsByFile = new Map<string, Edit[]>();
    for (const edit of this.edits.values()) {
      const edits = editsByFile.get(edit.symbol.filePath) ?? [];
      edits.push(edit);
      editsByFile.set(edit.symbol.filePath, edits);
    }

    return [...editsByFile].map(([filePath, edits]) => {
      const absolutePath = resolve(this.root, filePath);
      const before = readFileSync(absolutePath, "utf8");
      this.assertUnchanged(filePath, before);
      const ordered = edits.sort((a, b) => b.symbol.start - a.symbol.start);
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1]!;
        const current = ordered[index]!;
        if (current.symbol.end > previous.symbol.start) {
          throw new Error(`Overlapping edits in ${filePath}`);
        }
      }
      let after = before;
      for (const edit of ordered) {
        after = after.slice(0, edit.symbol.start) + edit.replacement + after.slice(edit.symbol.end);
      }
      const diagnostics = ts.transpileModule(after, {
        fileName: absolutePath,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
      if (diagnostics.length > 0) {
        const message = ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, "\n");
        throw new Error(`Invalid staged source in ${filePath}: ${message}`);
      }
      return { filePath, before, after };
    });
  }

  commit(): string[] {
    const previews = this.preview();
    if (previews.length === 0) return [];
    const nonce = `${process.pid}-${Date.now()}`;
    const prepared = previews.map((preview) => {
      const path = resolve(this.root, preview.filePath);
      const temporary = `${path}.grove-${nonce}.tmp`;
      const backup = `${path}.grove-${nonce}.bak`;
      writeFileSync(temporary, preview.after, "utf8");
      chmodSync(temporary, statSync(path).mode);
      return { ...preview, path, temporary, backup };
    });

    const backedUp: typeof prepared = [];
    const installed: typeof prepared = [];
    try {
      for (const file of prepared) {
        renameSync(file.path, file.backup);
        backedUp.push(file);
      }
      for (const file of prepared) {
        renameSync(file.temporary, file.path);
        installed.push(file);
      }
    } catch (error) {
      for (const file of installed.reverse()) rmSync(file.path, { force: true });
      for (const file of backedUp.reverse()) {
        if (existsSync(file.backup)) renameSync(file.backup, file.path);
      }
      for (const file of prepared) rmSync(file.temporary, { force: true });
      throw error;
    }
    for (const file of prepared) rmSync(file.backup, { force: true });
    this.edits.clear();
    return prepared.map((file) => file.filePath);
  }

  private assertUnchanged(filePath: string, source: string): void {
    const indexed = this.db.prepare("SELECT content_hash AS contentHash FROM files WHERE path = ?").get(filePath) as
      | { contentHash: string }
      | undefined;
    if (!indexed || indexed.contentHash !== hash(source)) {
      throw new Error(`${filePath} changed since indexing; re-index before editing`);
    }
  }
}
