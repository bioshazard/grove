-- Queryable Codebase SQLite Schema
-- Based on DESIGN.md specifications

-- =============================================================================
-- FILES TABLE
-- Materialization targets; import boundary markers
-- =============================================================================
CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    language TEXT NOT NULL -- 'typescript', 'python', etc.
);

-- Index for looking up file by path (materialization target resolution)
CREATE INDEX idx_files_path ON files(path);

-- Index for filtering by language (language-specific operations)
CREATE INDEX idx_files_language ON files(language);

-- =============================================================================
-- NODES TABLE  
-- Every CST node with parent-child relationships forming the concrete syntax tree
-- =============================================================================
CREATE TABLE nodes (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, -- node type: 'function_declaration', 'identifier', 'arrow_function', etc.
    parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    start INTEGER NOT NULL, -- start position (character offset or line/column)
    end INTEGER NOT NULL,   -- end position
    properties TEXT,        -- JSON blob for language-specific node properties
    
    -- Constraints
    CONSTRAINT chk_positions CHECK (start < end)
);

-- Index for parent traversal (finding all children of a node)
CREATE INDEX idx_nodes_parent_id ON nodes(parent_id);

-- Index for finding all nodes in a file
CREATE INDEX idx_nodes_file_id ON nodes(file_id);

-- Index for querying by node kind (e.g., find all function declarations)
CREATE INDEX idx_nodes_kind ON nodes(kind);

-- Composite index for file + kind queries (find all functions in file X)
CREATE INDEX idx_nodes_file_kind ON nodes(file_id, kind);

-- =============================================================================
-- SYMBOLS TABLE
-- Cross-file semantic index with versioning for concurrency control
-- =============================================================================
CREATE TABLE symbols (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL, -- 'function', 'class', 'variable', 'interface', 'type_alias', etc.
    definition_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1, -- concurrency primitive; increments on mutation
    
    -- Unique constraint: same name + kind maps to one canonical symbol
    UNIQUE(name, kind)
);

-- Index for symbol lookup by name (primary query pattern)
CREATE INDEX idx_symbols_name ON symbols(name);

-- Index for finding all symbols of a kind (e.g., all functions)
CREATE INDEX idx_symbols_kind ON symbols(kind);

-- Index for resolving symbol to its definition node
CREATE INDEX idx_symbols_definition_node_id ON symbols(definition_node_id);

-- Composite index for name + kind lookups (exact symbol resolution)
CREATE INDEX idx_symbols_name_kind ON symbols(name, kind);

-- =============================================================================
-- SYMBOL REFERENCES TABLE
-- Tracks where symbols are referenced (for caller finding)
-- =============================================================================
CREATE TABLE symbol_references (
    symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    reference_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    
    PRIMARY KEY (symbol_id, reference_node_id)
);

-- Index for finding all references to a symbol (caller finding)
CREATE INDEX idx_symbol_references_symbol_id ON symbol_references(symbol_id);

-- Index for finding what symbol a node references (reverse lookup)
CREATE INDEX idx_symbol_references_reference_node_id ON symbol_references(reference_node_id);

-- =============================================================================
-- TRACES TABLE
-- OTel spans from REPL and CDP traces; full-stack runtime behavior
-- =============================================================================
CREATE TABLE traces (
    id INTEGER PRIMARY KEY,
    span_id TEXT NOT NULL UNIQUE, -- OTel span ID (hex string)
    parent_span_id TEXT,          -- Parent span ID for trace tree structure
    name TEXT NOT NULL,           -- Span operation name
    start_time INTEGER NOT NULL,  -- Unix timestamp in microseconds
    end_time INTEGER,             -- Unix timestamp in microseconds (nullable for open spans)
    attributes TEXT,              -- JSON blob of span attributes
    
    -- Foreign key reference to symbol if this span corresponds to a code location
    symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
    
    CONSTRAINT chk_trace_times CHECK (
        end_time IS NULL OR end_time >= start_time
    )
);

-- Index for finding span by ID (trace lookup)
CREATE INDEX idx_traces_span_id ON traces(span_id);

-- Index for parent traversal (finding child spans)
CREATE INDEX idx_traces_parent_span_id ON traces(parent_span_id);

-- Index for time-range queries (find spans in time window)
CREATE INDEX idx_traces_start_time ON traces(start_time);

-- Composite index for duration queries (find slow spans)
CREATE INDEX idx_traces_duration ON traces(start_time, end_time);

-- Index for joining traces with symbols (runtime + structure joins)
CREATE INDEX idx_traces_symbol_id ON traces(symbol_id);

-- =============================================================================
-- VIEW: Span Duration Calculation
-- =============================================================================
CREATE VIEW IF NOT EXISTS v_span_durations AS
SELECT 
    id,
    span_id,
    name,
    start_time,
    end_time,
    (end_time - start_time) AS duration_us,
    (end_time - start_time) / 1000.0 AS duration_ms
FROM traces
WHERE end_time IS NOT NULL;

-- =============================================================================
-- VIEW: Symbol with File Location
-- =============================================================================
CREATE VIEW IF NOT EXISTS v_symbols_with_location AS
SELECT 
    s.id,
    s.name,
    s.kind,
    s.version,
    n.id AS definition_node_id,
    f.path AS definition_file,
    n.start AS start_position,
    n.end AS end_position
FROM symbols s
JOIN nodes n ON s.definition_node_id = n.id
JOIN files f ON n.file_id = f.id;

-- =============================================================================
-- VIEW: Symbol Callers (all references)
-- =============================================================================
CREATE VIEW IF NOT EXISTS v_symbol_callers AS
SELECT 
    s.id AS symbol_id,
    s.name AS symbol_name,
    s.kind AS symbol_kind,
    sr.reference_node_id,
    n.file_id,
    f.path AS caller_file,
    n.kind AS reference_kind,
    n.start,
    n.end
FROM symbols s
JOIN symbol_references sr ON s.id = sr.symbol_id
JOIN nodes n ON sr.reference_node_id = n.id
JOIN files f ON n.file_id = f.id;
