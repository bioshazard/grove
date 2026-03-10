import { Project, Node, SyntaxKind, Symbol } from 'ts-morph';
import type { Database as GroveDatabase } from './db';
import path from 'path';

export function createParser() {
  return new Project({
    useInMemoryFileSystem: true
  });
}

export function addFile(db: GroveDatabase, filePath: string, sourceText: string): number {
  // First check if file exists
  let existing = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as {id: number} | undefined;
  if (existing) {
    // Update existing file
    db.prepare('UPDATE files SET source = ? WHERE path = ?').run(sourceText, filePath);
    return existing.id;
  }
  
  // Insert new file
  const result = db.prepare(`
    INSERT INTO files (path, language, source) VALUES (?, ?, ?)
  `).run(filePath, 'typescript', sourceText);
  return result.lastInsertRowid as number;
}

export function clearFileNodes(db: GroveDatabase, fileId: number): void {
  // Delete symbols first (they reference nodes), then nodes
  db.prepare('DELETE FROM symbols WHERE definition_node_id IN (SELECT id FROM nodes WHERE file_id = ?)').run(fileId);
  db.prepare('DELETE FROM nodes WHERE file_id = ?').run(fileId);
}

interface NodeResult {
  id: number;
  kind: string;
  start: number;
  end: number;
  parent_id: number | null;
  properties: string | null;
}

export function hydrateSource(db: GroveDatabase, filePath: string, sourceText: string): number {
  const fileId = addFile(db, filePath, sourceText);
  clearFileNodes(db, fileId);

  const project = createParser();
  const sourceFile = project.createSourceFile(path.basename(filePath), sourceText);

  const nodeMap = new Map<Node, number>();

  function processNode(node: Node, parentId: number | null): void {
    const kind = SyntaxKind[node.getKind()];
    const start = node.getStart();
    const end = node.getEnd();

    const props: Record<string, unknown> = {};
    
        const symbol = node.getSymbol();
        if (symbol) {
          props.symbolName = symbol.getName();
          const declarations = symbol.getDeclarations();
          const isThisNodeDeclaration = declarations.some((decl: any) => {
            try {
              return decl.getStart() === start && decl.getEnd() === end;
            } catch {
              return false;
            }
          });
          if (isThisNodeDeclaration) {
            props.isDeclaration = true;
          }
        }

    if (kind === 'Identifier' && parentId) {
      const parentNode = node.getParent();
      if (parentNode) {
        const pk = SyntaxKind[parentNode.getKind()];
        // Check if this identifier is part of a declaration in THIS file
        const isDeclContext = ['FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'MethodDeclaration', 'PropertyDeclaration', 'VariableDeclaration'].includes(pk);
        
        // Check if it's an import specifier (not a definition)
        const isImportSpecifier = pk === 'ImportSpecifier';
        const grandParent = parentNode.getParent();
        const isImportClause = SyntaxKind[grandParent?.getKind() || 0] === 'ImportClause';
        
        // Only mark as declaration if it's in a declaration context AND not an import
        if (isDeclContext && !isImportSpecifier && !isImportClause) {
          props.isDeclaration = true;
        }
        // For import specifiers, explicitly set isDeclaration to false
        else if (isImportSpecifier) {
          props.isDeclaration = false;
        }
      }
    }

    const text = node.getText();
    if (text) {
      props.textLength = text.length;
    }

    const result = db.prepare(`
      INSERT INTO nodes (file_id, kind, parent_id, start, end, properties)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fileId, kind, parentId, start, end, JSON.stringify(props));

    const nodeId = result.lastInsertRowid as number;
    nodeMap.set(node, nodeId);

    for (const child of node.getChildren()) {
      processNode(child, nodeId);
    }
  }

  const rootChildren = sourceFile.getChildren();
  for (const child of rootChildren) {
    processNode(child, null);
  }

  extractSymbols(db, fileId, sourceFile, nodeMap);

  return fileId;
}

function extractSymbols(
  db: GroveDatabase, 
  fileId: number, 
  sourceFile: ReturnType<Project['createSourceFile']>,
  nodeMap: Map<Node, number>
): void {
  const symbols = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
  
  for (const func of symbols) {
    const name = func.getName();
    if (!name) continue;

    const nodeId = nodeMap.get(func);
    if (!nodeId) continue;

    db.prepare(`
      INSERT INTO symbols (name, kind, definition_node_id, version)
      VALUES (?, ?, ?, 1)
    `).run(name, 'function', nodeId);
  }

  const classes = sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration);
  for (const cls of classes) {
    const name = cls.getName();
    if (!name) continue;

    const nodeId = nodeMap.get(cls);
    if (!nodeId) continue;

    db.prepare(`
      INSERT INTO symbols (name, kind, definition_node_id, version)
      VALUES (?, ?, ?, 1)
    `).run(name, 'class', nodeId);
  }

  const interfaces = sourceFile.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration);
  for (const iface of interfaces) {
    const name = iface.getName();
    if (!name) continue;

    const nodeId = nodeMap.get(iface);
    if (!nodeId) continue;

    db.prepare(`
      INSERT INTO symbols (name, kind, definition_node_id, version)
      VALUES (?, ?, ?, 1)
    `).run(name, 'interface', nodeId);
  }

  const variables = sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement);
  for (const varStmt of variables) {
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName();
      const nodeId = nodeMap.get(decl);
      if (!name || !nodeId) continue;

      db.prepare(`
        INSERT INTO symbols (name, kind, definition_node_id, version)
        VALUES (?, ?, ?, 1)
      `).run(name, 'variable', nodeId);
    }
  }
}

export interface SymbolInfo {
  id: number;
  name: string;
  kind: string;
  definition_node_id: number | null;
  version: number;
}

export function symbolQuery(db: GroveDatabase, name: string): SymbolInfo[] {
  return db.prepare(`
    SELECT id, name, kind, definition_node_id, version
    FROM symbols
    WHERE name = ?
  `).all(name) as SymbolInfo[];
}

export function findCallers(db: GroveDatabase, symbolName: string): { 
  filePath: string; 
  line: number; 
  text: string; 
}[] {
  const symbol = symbolQuery(db, symbolName)[0];
  if (!symbol) return [];

  const defNode = db.prepare(`
    SELECT n.start, n.end, f.path
    FROM nodes n
    JOIN files f ON n.file_id = f.id
    WHERE n.id = ?
  `).get(symbol.definition_node_id) as { start: number; end: number; path: string } | undefined;

  if (!defNode) return [];

  const refs = db.prepare(`
    SELECT DISTINCT f.path, n.start, n.end, n.kind, n.properties
    FROM nodes n
    JOIN files f ON n.file_id = f.id
    WHERE n.kind = 'Identifier' 
    AND n.properties LIKE ?
  `).all(`%${symbolName}%`) as { path: string; start: number; end: number; kind: string; properties: string }[];

  const results: { filePath: string; line: number; text: string }[] = [];
  
  for (const ref of refs) {
    const props = JSON.parse(ref.properties || '{}');
    if (props.symbolName === symbolName) {
      if (props.isDeclaration) {
        continue;
      }

      const file = db.prepare(`SELECT source FROM files WHERE path = ?`).get(ref.path) as { source: string } | undefined;
      let line = 1;
      if (file?.source) {
        const upToPos = file.source.substring(0, ref.start);
        line = (upToPos.match(/\n/g) || []).length + 1;
      }
      
      results.push({
        filePath: ref.path,
        line,
        text: props.symbolName || ''
      });
    }
  }

  return results;
}

export interface SymbolWithReferences extends SymbolInfo {
  filePath: string;
  references: { filePath: string; line: number; column: number; isDefinition: boolean }[];
}

export function getAllSymbols(db: GroveDatabase): SymbolInfo[] {
  return db.prepare(`
    SELECT id, name, kind, definition_node_id, version
    FROM symbols
    ORDER BY name
  `).all() as SymbolInfo[];
}

export function getSymbolWithReferences(db: GroveDatabase, symbolName: string): SymbolWithReferences | null {
  const symbols = symbolQuery(db, symbolName);
  if (symbols.length === 0) return null;
  
  const sym = symbols[0]!;
  
  // Get the definition file path
  let filePath = '';
  let defStart = 0;
  let defEnd = 0;
  
  if (sym.definition_node_id) {
    const node = db.prepare(`
      SELECT n.start, n.end, f.path
      FROM nodes n
      JOIN files f ON n.file_id = f.id
      WHERE n.id = ?
    `).get(sym.definition_node_id) as { start: number; end: number; path: string } | undefined;
    
    if (node) {
      filePath = node.path;
      defStart = node.start;
      defEnd = node.end;
    }
  }
  
  // Find all references to this symbol
  const references: { filePath: string; line: number; column: number; isDefinition: boolean }[] = [];
  
  const refNodes = db.prepare(`
    SELECT n.id, n.start, n.end, n.properties, f.path
    FROM nodes n
    JOIN files f ON n.file_id = f.id
    WHERE n.kind = 'Identifier'
  `).all() as { id: number; start: number; end: number; properties: string | null; path: string }[];
  
  for (const ref of refNodes) {
    if (!ref.properties) continue;
    
    try {
      const props = JSON.parse(ref.properties);
      if (props.symbolName === symbolName) {
        const source = db.prepare('SELECT source FROM files WHERE path = ?').get(ref.path) as { source: string } | undefined;
        if (!source) continue;
        
        const textBefore = source.source.substring(0, ref.start);
        const line = (textBefore.match(/\n/g) || []).length + 1;
        const column = ref.start - textBefore.lastIndexOf('\n');
        
        const isDefinition = props.isDeclaration || (ref.start === defStart && ref.end === defEnd);
        
        references.push({
          filePath: ref.path,
          line,
          column,
          isDefinition
        });
      }
    } catch {
      // Skip invalid properties
    }
  }
  
  return {
    id: sym.id,
    name: sym.name,
    kind: sym.kind,
    definition_node_id: sym.definition_node_id,
    version: sym.version,
    filePath,
    references: references.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)
  };
}

export function materializeSource(db: GroveDatabase, fileId: number): string {
  const file = db.prepare('SELECT source FROM files WHERE id = ?').get(fileId) as { source: string } | undefined;
  if (!file) return '';
  return file.source;
}

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  startTime: number;
  endTime: number;
  attributes?: Record<string, unknown>;
  symbolId?: number | null;
}

export function insertTrace(db: GroveDatabase, span: TraceSpan): number {
  const result = db.prepare(`
    INSERT INTO traces (span_id, parent_span_id, name, start_time, end_time, attributes, symbol_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    span.spanId,
    span.parentSpanId || null,
    span.name,
    span.startTime,
    span.endTime,
    span.attributes ? JSON.stringify(span.attributes) : null,
    span.symbolId ?? null
  );
  return result.lastInsertRowid as number;
}

export function insertTraces(db: GroveDatabase, spans: TraceSpan[]): number[] {
  const ids: number[] = [];
  for (const span of spans) {
    ids.push(insertTrace(db, span));
  }
  return ids;
}

export interface TraceQueryResult {
  id: number;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time: number;
  end_time: number;
  attributes: Record<string, unknown> | null;
  symbol_id: number | null;
}

export function queryTraces(db: GroveDatabase, sql: string, params: unknown[] = []): TraceQueryResult[] {
  return db.prepare(sql).all(...params) as TraceQueryResult[];
}

export function resolveSymbolId(db: GroveDatabase, symbolName: string): number | null {
  const symbols = symbolQuery(db, symbolName);
  if (symbols.length === 0) return null;
  return symbols[0]!.id;
}

export interface SymbolTraceJoinResult {
  symbolName: string;
  symbolKind: string;
  filePath: string;
  traceCount: number;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
  minDurationMs: number | null;
}

export function joinTracesWithSymbols(
  db: GroveDatabase,
  minDurationMs?: number
): SymbolTraceJoinResult[] {
  let query = `
    SELECT 
      s.name as symbolName,
      s.kind as symbolKind,
      f.path as filePath,
      COUNT(t.id) as traceCount,
      AVG(json_extract(t.attributes, '$.duration_ms')) as avgDurationMs,
      MAX(json_extract(t.attributes, '$.duration_ms')) as maxDurationMs,
      MIN(json_extract(t.attributes, '$.duration_ms')) as minDurationMs
    FROM symbols s
    JOIN nodes n ON s.definition_node_id = n.id
    JOIN files f ON n.file_id = f.id
    JOIN traces t ON t.symbol_id = s.id
    WHERE json_extract(t.attributes, '$.duration_ms') IS NOT NULL
  `;
  
  const params: unknown[] = [];
  
  if (minDurationMs !== undefined) {
    query += ` AND json_extract(t.attributes, '$.duration_ms') >= ?`;
    params.push(minDurationMs);
  }
  
  query += `
    GROUP BY s.id, s.name, s.kind, f.path
    ORDER BY avgDurationMs DESC
  `;
  
  return db.prepare(query).all(...params) as SymbolTraceJoinResult[];
}

export interface SlowTraceWithSymbol {
  traceId: number;
  spanId: string;
  name: string;
  durationMs: number;
  symbolName: string | null;
  symbolKind: string | null;
  filePath: string | null;
}

export function findSlowTracesWithSymbols(
  db: GroveDatabase,
  minDurationMs: number,
  limit: number = 100
): SlowTraceWithSymbol[] {
  return db.prepare(`
    SELECT 
      t.id as traceId,
      t.span_id as spanId,
      t.name,
      json_extract(t.attributes, '$.duration_ms') as durationMs,
      s.name as symbolName,
      s.kind as symbolKind,
      f.path as filePath
    FROM traces t
    LEFT JOIN symbols s ON t.symbol_id = s.id
    LEFT JOIN nodes n ON s.definition_node_id = n.id
    LEFT JOIN files f ON n.file_id = f.id
    WHERE json_extract(t.attributes, '$.duration_ms') >= ?
    ORDER BY durationMs DESC
    LIMIT ?
  `).all(minDurationMs, limit) as SlowTraceWithSymbol[];
}

export interface NodeMutation {
  type: 'insert' | 'delete' | 'replace' | 'update_properties';
  targetNodeId?: number;
  parentNodeId?: number;
  newSource?: string;
  newProperties?: Record<string, unknown>;
}

export interface MutationResult {
  success: boolean;
  errorMessage?: string;
  changes: number;
  newNodeIds?: number[];
}

export function nodeMutate(db: GroveDatabase, fileId: number, mutation: NodeMutation): MutationResult {
  const file = db.prepare('SELECT id, path, source FROM files WHERE id = ?').get(fileId) as { id: number; path: string; source: string } | undefined;
  if (!file) {
    return { success: false, errorMessage: 'File not found', changes: 0 };
  }

  const project = createParser();
  const sourceFile = project.createSourceFile(path.basename(file.path), file.source);

  switch (mutation.type) {
    case 'delete': {
      if (!mutation.targetNodeId) {
        return { success: false, errorMessage: 'targetNodeId required for delete', changes: 0 };
      }
      
      const nodeToDelete = db.prepare('SELECT start, end FROM nodes WHERE id = ?').get(mutation.targetNodeId) as { start: number; end: number } | undefined;
      if (!nodeToDelete) {
        return { success: false, errorMessage: 'Node not found', changes: 0 };
      }

      const newSource = file.source.substring(0, nodeToDelete.start) + file.source.substring(nodeToDelete.end);
      
      db.prepare('UPDATE files SET source = ? WHERE id = ?').run(newSource, fileId);
      db.prepare('DELETE FROM nodes WHERE file_id = ?').run(fileId);
      
      const newSourceFile = project.createSourceFile(path.basename(file.path), newSource);
      const nodeMap = new Map<any, number>();
      
      function processNode(node: any, parentId: number | null): void {
        const kind = SyntaxKind[node.getKind()];
        const start = node.getStart();
        const end = node.getEnd();

        const props: Record<string, unknown> = {};
        
        const symbol = node.getSymbol();
        if (symbol) {
          props.symbolName = symbol.getName();
          const declarations = symbol.getDeclarations();
          const isThisNodeDeclaration = declarations.some((decl: any) => {
            try {
              return decl.getStart() === start && decl.getEnd() === end;
            } catch {
              return false;
            }
          });
          if (isThisNodeDeclaration) {
            props.isDeclaration = true;
          }
        }

        if (kind === 'Identifier' && parentId) {
          const parentNode = node.getParent();
          if (parentNode) {
            const pk = SyntaxKind[parentNode.getKind()] || '';
            const isDeclContext = ['FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'MethodDeclaration', 'PropertyDeclaration', 'VariableDeclaration'].includes(pk);
            const isImportSpecifier = pk === 'ImportSpecifier';
            const grandParent = parentNode.getParent();
            const isImportClause = SyntaxKind[grandParent?.getKind() || 0] === 'ImportClause';
            
            if (isDeclContext && !isImportSpecifier && !isImportClause) {
              props.isDeclaration = true;
            } else if (isImportSpecifier) {
              props.isDeclaration = false;
            }
          }
        }

        const text = node.getText();
        if (text) {
          props.textLength = text.length;
        }

        db.prepare(`
          INSERT INTO nodes (file_id, kind, parent_id, start, end, properties)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(fileId, kind, parentId, start, end, JSON.stringify(props));

        const nodeId = db.prepare('SELECT last_insert_rowid()').get() as { "last_insert_rowid()": number };
        nodeMap.set(node, nodeId["last_insert_rowid()"]);

        for (const child of node.getChildren()) {
          processNode(child, nodeId["last_insert_rowid()"]);
        }
      }

      const rootChildren = newSourceFile.getChildren();
      for (const child of rootChildren) {
        processNode(child, null);
      }

      extractSymbols(db, fileId, newSourceFile, nodeMap);

      return { success: true, changes: 1 };
    }

    case 'insert': {
      if (!mutation.parentNodeId || !mutation.newSource) {
        return { success: false, errorMessage: 'parentNodeId and newSource required for insert', changes: 0 };
      }

      const parent = db.prepare('SELECT start, end FROM nodes WHERE id = ?').get(mutation.parentNodeId) as { start: number; end: number } | undefined;
      if (!parent) {
        return { success: false, errorMessage: 'Parent node not found', changes: 0 };
      }

      const insertPos = parent.end - 1;
      const newSource = file.source.substring(0, insertPos) + mutation.newSource + file.source.substring(insertPos);
      
      db.prepare('UPDATE files SET source = ? WHERE id = ?').run(newSource, fileId);
      db.prepare('DELETE FROM nodes WHERE file_id = ?').run(fileId);
      
      const newSourceFile = project.createSourceFile(path.basename(file.path), newSource);
      const nodeMap = new Map<any, number>();
      
      function processNode(node: any, parentId: number | null): void {
        const kind = SyntaxKind[node.getKind()];
        const start = node.getStart();
        const end = node.getEnd();

        const props: Record<string, unknown> = {};
        
        const symbol = node.getSymbol();
        if (symbol) {
          props.symbolName = symbol.getName();
          const declarations = symbol.getDeclarations();
          const isThisNodeDeclaration = declarations.some((decl: any) => {
            try {
              return decl.getStart() === start && decl.getEnd() === end;
            } catch {
              return false;
            }
          });
          if (isThisNodeDeclaration) {
            props.isDeclaration = true;
          }
        }

        if (kind === 'Identifier' && parentId) {
          const parentNode = node.getParent();
          if (parentNode) {
            const pk = SyntaxKind[parentNode.getKind()] || '';
            const isDeclContext = ['FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'MethodDeclaration', 'PropertyDeclaration', 'VariableDeclaration'].includes(pk);
            const isImportSpecifier = pk === 'ImportSpecifier';
            const grandParent = parentNode.getParent();
            const isImportClause = SyntaxKind[grandParent?.getKind() || 0] === 'ImportClause';
            
            if (isDeclContext && !isImportSpecifier && !isImportClause) {
              props.isDeclaration = true;
            } else if (isImportSpecifier) {
              props.isDeclaration = false;
            }
          }
        }

        const text = node.getText();
        if (text) {
          props.textLength = text.length;
        }

        db.prepare(`
          INSERT INTO nodes (file_id, kind, parent_id, start, end, properties)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(fileId, kind, parentId, start, end, JSON.stringify(props));

        const nodeId = db.prepare('SELECT last_insert_rowid()').get() as { "last_insert_rowid()": number };
        nodeMap.set(node, nodeId["last_insert_rowid()"]);

        for (const child of node.getChildren()) {
          processNode(child, nodeId["last_insert_rowid()"]);
        }
      }

      const rootChildren = newSourceFile.getChildren();
      for (const child of rootChildren) {
        processNode(child, null);
      }

      extractSymbols(db, fileId, newSourceFile, nodeMap);

      return { success: true, changes: 1 };
    }

    case 'replace': {
      if (!mutation.targetNodeId || !mutation.newSource) {
        return { success: false, errorMessage: 'targetNodeId and newSource required for replace', changes: 0 };
      }

      const nodeToReplace = db.prepare('SELECT start, end FROM nodes WHERE id = ?').get(mutation.targetNodeId) as { start: number; end: number } | undefined;
      if (!nodeToReplace) {
        return { success: false, errorMessage: 'Node not found', changes: 0 };
      }

      const newSource = file.source.substring(0, nodeToReplace.start) + mutation.newSource + file.source.substring(nodeToReplace.end);
      
      db.prepare('UPDATE files SET source = ? WHERE id = ?').run(newSource, fileId);
      db.prepare('DELETE FROM nodes WHERE file_id = ?').run(fileId);
      
      const newSourceFile = project.createSourceFile(path.basename(file.path), newSource);
      const nodeMap = new Map<any, number>();
      
      function processNode(node: any, parentId: number | null): void {
        const kind = SyntaxKind[node.getKind()];
        const start = node.getStart();
        const end = node.getEnd();

        const props: Record<string, unknown> = {};
        
        const symbol = node.getSymbol();
        if (symbol) {
          props.symbolName = symbol.getName();
          const declarations = symbol.getDeclarations();
          const isThisNodeDeclaration = declarations.some((decl: any) => {
            try {
              return decl.getStart() === start && decl.getEnd() === end;
            } catch {
              return false;
            }
          });
          if (isThisNodeDeclaration) {
            props.isDeclaration = true;
          }
        }

        if (kind === 'Identifier' && parentId) {
          const parentNode = node.getParent();
          if (parentNode) {
            const pk = SyntaxKind[parentNode.getKind()] || '';
            const isDeclContext = ['FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'MethodDeclaration', 'PropertyDeclaration', 'VariableDeclaration'].includes(pk);
            const isImportSpecifier = pk === 'ImportSpecifier';
            const grandParent = parentNode.getParent();
            const isImportClause = SyntaxKind[grandParent?.getKind() || 0] === 'ImportClause';
            
            if (isDeclContext && !isImportSpecifier && !isImportClause) {
              props.isDeclaration = true;
            } else if (isImportSpecifier) {
              props.isDeclaration = false;
            }
          }
        }

        const text = node.getText();
        if (text) {
          props.textLength = text.length;
        }

        db.prepare(`
          INSERT INTO nodes (file_id, kind, parent_id, start, end, properties)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(fileId, kind, parentId, start, end, JSON.stringify(props));

        const nodeId = db.prepare('SELECT last_insert_rowid()').get() as { "last_insert_rowid()": number };
        nodeMap.set(node, nodeId["last_insert_rowid()"]);

        for (const child of node.getChildren()) {
          processNode(child, nodeId["last_insert_rowid()"]);
        }
      }

      const rootChildren = newSourceFile.getChildren();
      for (const child of rootChildren) {
        processNode(child, null);
      }

      extractSymbols(db, fileId, newSourceFile, nodeMap);

      return { success: true, changes: 1 };
    }

    case 'update_properties': {
      if (!mutation.targetNodeId || !mutation.newProperties) {
        return { success: false, errorMessage: 'targetNodeId and newProperties required for update_properties', changes: 0 };
      }

      const result = db.prepare('UPDATE nodes SET properties = ? WHERE id = ?').run(JSON.stringify(mutation.newProperties), mutation.targetNodeId);
      
      return { success: true, changes: result.changes };
    }

    default:
      return { success: false, errorMessage: `Unknown mutation type: ${(mutation as any).type}`, changes: 0 };
  }
}

export function materialize(db: GroveDatabase, filePath: string): string {
  const file = db.prepare('SELECT id, source FROM files WHERE path = ?').get(filePath) as { id: number; source: string } | undefined;
  if (!file) return '';
  
  const sourceText = file.source;
  const nodes = db.prepare(`
    SELECT id, kind, parent_id, start, end
    FROM nodes
    WHERE file_id = ?
    ORDER BY start
  `).all(file.id) as NodeResult[];

  const childrenMap = new Map<number | null, NodeResult[]>();
  
  for (const node of nodes) {
    const parentId = node.parent_id;
    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, []);
    }
    childrenMap.get(parentId)!.push(node);
  }

  const rootChildren = childrenMap.get(null) || [];
  const sortedRoots = rootChildren.sort((a, b) => a.start - b.start);
  
  let result = '';
  let lastEnd = 0;
  
  for (const root of sortedRoots) {
    // Add any gap content before this root child
    if (root.start > lastEnd) {
      result += sourceText.substring(lastEnd, root.start);
    }
    result += materializeNode(root, childrenMap, sourceText);
    lastEnd = root.end;
  }
  
  // Add any trailing content after last root child
  if (lastEnd < sourceText.length) {
    result += sourceText.substring(lastEnd);
  }
  
  return result;
}

export * from './repl';

function materializeNode(node: NodeResult, childrenMap: Map<number | null, NodeResult[]>, sourceText: string): string {
  const children = childrenMap.get(node.id) || [];
  
  if (children.length === 0) {
    return sourceText.substring(node.start, node.end);
  }
  
  const sortedChildren = children.sort((a, b) => a.start - b.start);
  
  // Filter out trivia tokens (kinds 2-5: comments, whitespace, newlines)
  // These are handled by gap-filling between meaningful nodes
  const meaningfulChildren = sortedChildren.filter(c => parseInt(c.kind) > 5);
  
  if (meaningfulChildren.length === 0) {
    return sourceText.substring(node.start, node.end);
  }
  
  let result = '';
  let lastEnd = meaningfulChildren[0]?.start ?? node.start;
  
  for (const child of meaningfulChildren) {
    if (child.start > lastEnd) {
      result += sourceText.substring(lastEnd, child.start);
    }
    result += materializeNode(child, childrenMap, sourceText);
    lastEnd = child.end;
  }
  
  return result;
}
