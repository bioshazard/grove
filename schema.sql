-- Documentation copy. src/db.ts owns runtime migrations.
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE symbols (
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

CREATE TABLE symbol_references (
  symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column_number INTEGER NOT NULL,
  is_definition INTEGER NOT NULL,
  PRIMARY KEY (symbol_id, file_id, start, end)
);

CREATE TABLE traces (
  id INTEGER PRIMARY KEY,
  span_id TEXT NOT NULL UNIQUE,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  attributes TEXT,
  symbol_id TEXT REFERENCES symbols(id) ON DELETE SET NULL
);
