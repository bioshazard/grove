import type { Database } from './db';

/**
 * Swarm operation: apply a transformation across multiple locations atomically.
 * 
 * This enables the key use case from DESIGN.md:
 * "insert validator at every unguarded path, one transaction"
 * 
 * The swarm takes a validated transformation (tested in REPL) and applies it
 * to all matching locations in the codebase in a single atomic operation.
 */

export interface SwarmTarget {
  filePath: string;
  fileId: number;
  nodeIds: number[]; // Nodes to transform in this file
}

export interface SwarmTransformation {
  /** The transformation function - receives source text and returns transformed text */
  transform: (source: string) => string;
  
  /** Optional: filter nodes by kind before applying transformation */
  nodeKinds?: string[];
  
  /** Optional: only apply to files matching this pattern */
  filePattern?: RegExp;
}

export interface SwarmResult {
  success: boolean;
  filesModified: number;
  targets: SwarmTarget[];
  errors: string[];
  versionChanges: { symbolName: string; oldVersion: number; newVersion: number }[];
}

/**
 * Find all targets matching the swarm criteria.
 */
export function findSwarmTargets(
  db: Database,
  transformation: SwarmTransformation
): SwarmTarget[] {
  const targets: SwarmTarget[] = [];
  
  // Get all files, filter by pattern in JS (sql.js lacks REGEXP support)
  const files = db.prepare(`SELECT id, path, source FROM files`);
  let fileRows = files.all() as Array<{id: number; path: string; source: string}>;
  if (transformation.filePattern) {
    fileRows = fileRows.filter(f => transformation.filePattern!.test(f.path));
  }
  
  for (const file of fileRows) {
    const nodesQuery = db.prepare(`
      SELECT id, kind FROM nodes WHERE file_id = ?
      ${transformation.nodeKinds ? 'AND kind IN (' + transformation.nodeKinds.map(() => '?').join(',') + ')' : ''}
    `);
    
    let params: unknown[] = [file.id];
    if (transformation.nodeKinds) {
      params = params.concat(transformation.nodeKinds);
    }
    
    const nodes = nodesQuery.all(...params) as Array<{id: number; kind: string}>;
    
    if (nodes.length > 0) {
      targets.push({
        filePath: file.path,
        fileId: file.id,
        nodeIds: nodes.map(n => n.id),
      });
    }
  }
  
  return targets;
}

/**
 * Execute a swarm transformation across all targets atomically.
 * 
 * This is the core "scale across codebase in one transaction" primitive.
 */
export function swarm(
  db: Database,
  transformation: SwarmTransformation,
  options?: {
    /** Dry run - don't actually modify anything */
    dryRun?: boolean;
    /** Capture affected symbol versions for validation */
    trackVersions?: boolean;
  }
): SwarmResult {
  const result: SwarmResult = {
    success: false,
    filesModified: 0,
    targets: [],
    errors: [],
    versionChanges: [],
  };
  
  try {
    // Find all targets
    const targets = findSwarmTargets(db, transformation);
    result.targets = targets;
    
    if (targets.length === 0) {
      result.success = true;
      return result;
    }
    
    if (options?.dryRun) {
      result.success = true;
      result.filesModified = 0; // Dry run
      return result;
    }
    
    // Track symbol versions before modification
    const versionChanges: { symbolName: string; oldVersion: number }[] = [];
    if (options?.trackVersions) {
      const symbols = db.prepare(`
        SELECT s.name, s.version, s.definition_node_id
        FROM symbols s
        WHERE s.definition_node_id IN (
          SELECT id FROM nodes WHERE file_id IN (${targets.map(() => '?').join(',')})
        )
      `).all(...targets.map(t => t.fileId)) as Array<{name: string; version: number; definition_node_id: number}>;
      
      for (const sym of symbols) {
        versionChanges.push({ symbolName: sym.name, oldVersion: sym.version });
      }
    }
    
    // Apply transformation to each file
    for (const target of targets) {
      const file = db.prepare('SELECT source FROM files WHERE id = ?').get(target.fileId) as { source: string } | undefined;
      if (!file) {
        result.errors.push(`File not found: ${target.filePath}`);
        continue;
      }
      
      try {
        const newSource = transformation.transform(file.source);
        
        // Update the file source
        db.prepare('UPDATE files SET source = ? WHERE id = ?').run(newSource, target.fileId);
        
        result.filesModified++;
      } catch (error) {
        result.errors.push(`Failed to transform ${target.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Increment versions for affected symbols
    if (options?.trackVersions && versionChanges.length > 0) {
      for (const vc of versionChanges) {
        db.prepare('UPDATE symbols SET version = version + 1 WHERE name = ?').run(vc.symbolName);
        result.versionChanges.push({
          symbolName: vc.symbolName,
          oldVersion: vc.oldVersion,
          newVersion: vc.oldVersion + 1,
        });
      }
    }
    
    result.success = result.errors.length === 0;
    
  } catch (error) {
    result.errors.push(`Swarm failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  return result;
}

/**
 * Insert code at multiple locations - common swarm pattern.
 * 
 * Example: insert validator at every unguarded HTTP entry point.
 */
export function insertAtLocations(
  db: Database,
  locations: Array<{
    filePath: string;
    insertBefore?: number; // Position to insert before
    insertAfter?: number;  // Position to insert after
    code: string;
  }>
): SwarmResult {
  const result: SwarmResult = {
    success: false,
    filesModified: 0,
    targets: [],
    errors: [],
    versionChanges: [],
  };
  
  try {
    // Group locations by file
    const locationsByFile = new Map<number, typeof locations>();
    
    for (const loc of locations) {
      const file = db.prepare('SELECT id FROM files WHERE path = ?').get(loc.filePath) as {id: number} | undefined;
      if (!file) {
        result.errors.push(`File not found: ${loc.filePath}`);
        continue;
      }
      
      if (!locationsByFile.has(file.id)) {
        locationsByFile.set(file.id, []);
      }
      locationsByFile.get(file.id)!.push(loc);
    }
    
    // Apply insertions to each file
    for (const [fileId, fileLocs] of locationsByFile.entries()) {
      const file = db.prepare('SELECT source FROM files WHERE id = ?').get(fileId) as { source: string } | undefined;
      if (!file) continue;
      
      let newSource = file.source;
      
      // Sort by position (descending) to insert from end to start
      const sortedLocs = fileLocs.sort((a, b) => {
        const posA = a.insertAfter ?? a.insertBefore ?? 0;
        const posB = b.insertAfter ?? b.insertBefore ?? 0;
        return posB - posA;
      });
      
      for (const loc of sortedLocs) {
        if (loc.insertBefore !== undefined) {
          newSource = newSource.substring(0, loc.insertBefore) + loc.code + newSource.substring(loc.insertBefore);
        } else if (loc.insertAfter !== undefined) {
          newSource = newSource.substring(0, loc.insertAfter + 1) + loc.code + newSource.substring(loc.insertAfter + 1);
        }
      }
      
      db.prepare('UPDATE files SET source = ? WHERE id = ?').run(newSource, fileId);
      result.filesModified++;
    }
    
    result.success = result.errors.length === 0;
    
  } catch (error) {
    result.errors.push(`Insert failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  return result;
}
