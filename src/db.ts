import initSqlJs from "sql.js";
import type { Database as SqlJsDatabase, SqlValue } from "sql.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

let runtime: Awaited<ReturnType<typeof initSqlJs>> | undefined;

export interface Statement {
  run(...params: unknown[]): { lastInsertRowid: number; changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  run(sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number };
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(operation: () => T): T;
  save(path?: string): void;
  close(): void;
}

class GroveDatabase implements Database {
  constructor(private readonly database: SqlJsDatabase, private readonly path: string) {}

  run(sql: string, ...params: unknown[]) {
    this.database.run(sql, params as SqlValue[]);
    return this.metadata();
  }

  exec(sql: string): void {
    this.database.run(sql);
  }

  prepare(sql: string): Statement {
    return {
      run: (...params) => {
        const statement = this.database.prepare(sql);
        try {
          statement.run(params as SqlValue[]);
          return this.metadata();
        } finally {
          statement.free();
        }
      },
      get: (...params) => {
        const statement = this.database.prepare(sql);
        try {
          statement.bind(params as SqlValue[]);
          return statement.step() ? statement.getAsObject() : undefined;
        } finally {
          statement.free();
        }
      },
      all: (...params) => {
        const statement = this.database.prepare(sql);
        try {
          statement.bind(params as SqlValue[]);
          const rows: unknown[] = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally {
          statement.free();
        }
      },
    };
  }

  transaction<T>(operation: () => T): T {
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.exec("COMMIT");
      return result;
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }
  }

  save(path = this.path): void {
    writeFileSync(path, Buffer.from(this.database.export()));
  }

  close(): void {
    this.save();
    this.database.close();
  }

  private metadata() {
    const result = this.database.exec("SELECT last_insert_rowid(), changes()");
    const values = result[0]?.values[0];
    return { lastInsertRowid: Number(values?.[0] ?? 0), changes: Number(values?.[1] ?? 0) };
  }
}

export async function createDatabase(path: string): Promise<Database> {
  runtime ??= await initSqlJs();
  const database = existsSync(path)
    ? new runtime.Database(readFileSync(path))
    : new runtime.Database();
  resetIncompatibleIndex(database);
  const wrapper = new GroveDatabase(database, path);
  wrapper.exec(SCHEMA);
  return wrapper;
}

function resetIncompatibleIndex(database: SqlJsDatabase): void {
  const result = database.exec("PRAGMA table_info(symbols)");
  if (result.length === 0) return;
  const columns = result[0]!.values.map((row) => String(row[1])).join(",");
  const expected = "id,name,kind,file_id,start,end,line,column_number,exported";
  if (columns === expected) return;
  database.run("DROP TABLE IF EXISTS symbol_references");
  database.run("DROP TABLE IF EXISTS traces");
  database.run("DROP TABLE IF EXISTS symbols");
  database.run("DROP TABLE IF EXISTS files");
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    indexed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS symbols (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    line INTEGER NOT NULL,
    column_number INTEGER NOT NULL,
    exported INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS symbol_references (
    symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    line INTEGER NOT NULL,
    column_number INTEGER NOT NULL,
    is_definition INTEGER NOT NULL,
    PRIMARY KEY (symbol_id, file_id, start, end)
  );

  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY,
    span_id TEXT NOT NULL UNIQUE,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    attributes TEXT,
    symbol_id TEXT REFERENCES symbols(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
  CREATE INDEX IF NOT EXISTS idx_references_symbol ON symbol_references(symbol_id);
  CREATE INDEX IF NOT EXISTS idx_references_file ON symbol_references(file_id);
  CREATE INDEX IF NOT EXISTS idx_traces_symbol ON traces(symbol_id);
  CREATE INDEX IF NOT EXISTS idx_traces_time ON traces(start_time, end_time);
`;
