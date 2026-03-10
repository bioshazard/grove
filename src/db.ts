import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export interface Database {
  run(sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number };
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number; changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
  save(path: string): void;
}

class DatabaseWrapper implements Database {
  private db: SqlJsDatabase;
  private dbPath: string;

  constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  run(sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number } {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
    const lastIdResult = this.db.exec("SELECT last_insert_rowid() as id");
    const lastId = lastIdResult[0]?.values[0]?.[0] as number || 0;
    const changes = this.db.getRowsModified();
    return { lastInsertRowid: lastId, changes };
  }

  exec(sql: string): void {
    this.db.run(sql);
  }

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        stmt.bind(params as (string | number | null | Uint8Array)[]);
        stmt.step();
        const lastIdResult = this.db.exec("SELECT last_insert_rowid() as id");
        const lastId = lastIdResult[0]?.values[0]?.[0] as number || 0;
        const changes = this.db.getRowsModified();
        stmt.free();
        return { lastInsertRowid: lastId, changes };
      },
      get: (...params: unknown[]) => {
        stmt.bind(params as (string | number | null | Uint8Array)[]);
        const result = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return result;
      },
      all: (...params: unknown[]) => {
        stmt.bind(params as (string | number | null | Uint8Array)[]);
        const results: unknown[] = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      }
    };
  }

  close(): void {
    this.save(this.dbPath);
    this.db.close();
  }

  save(path: string): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(path, buffer);
  }
}

export async function createDatabase(dbPath: string): Promise<Database> {
  const SqlJs = await getSqlJs();
  
  let db: SqlJsDatabase;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SqlJs.Database(fileBuffer);
  } else {
    db = new SqlJs.Database();
  }

  const wrapper = new DatabaseWrapper(db, dbPath);

  wrapper.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      language TEXT NOT NULL,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      parent_id INTEGER,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      properties TEXT
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      definition_node_id INTEGER,
      version INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      attributes TEXT,
      symbol_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_file_id ON nodes(file_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_traces_span_id ON traces(span_id);
    CREATE INDEX IF NOT EXISTS idx_traces_symbol_id ON traces(symbol_id);
  `);

  return wrapper;
}
