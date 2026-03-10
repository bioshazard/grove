import { createDatabase, type Database } from './src/db';
import { 
  hydrateSource, 
  symbolQuery, 
  getAllSymbols, 
  findCallers, 
  materialize, 
  getSymbolWithReferences, 
  insertTraces, 
  queryTraces,
  resolveSymbolId,
  joinTracesWithSymbols,
  findSlowTracesWithSymbols
} from './src/parser';
import fs from 'fs';

const dbPath = '/tmp/grove-test.db';
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

const testSource = `// This is a test function
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

// Another function that calls greet
function sayHello() {
  const message = greet("world");
  console.log(message);
}

class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

interface Config {
  apiUrl: string;
  timeout: number;
}
`;

async function main() {
  console.log("=== Testing Phase 1: Core Engine ===\n");

  const db = await createDatabase(dbPath);

  console.log("1. Hydrating source into graph...");
  const startHydrate = performance.now();
  const fileId = hydrateSource(db, "test.ts", testSource);
  const hydrateTime = performance.now() - startHydrate;
  console.log(`   ✓ Hydrated in ${hydrateTime.toFixed(2)}ms`);
  console.log(`   File ID: ${fileId}`);

  console.log("\n2. Querying symbols...");
  const symbols = getAllSymbols(db);
  console.log(`   Found ${symbols.length} symbols:`);
  for (const sym of symbols) {
    console.log(`   - ${sym.name} (${sym.kind})`);
  }

  console.log("\n3. Testing symbol_query...");
  const greetSyms = symbolQuery(db, "greet");
  console.log(`   Found ${greetSyms.length} symbol(s) for 'greet':`);
  for (const sym of greetSyms) {
    console.log(`   - ${sym.name}: kind=${sym.kind}, version=${sym.version}`);
  }

  console.log("\n4. Testing roundtrip via our materializer...");
  const materialized = materialize(db, "test.ts");
  const roundtripPassed = materialized === testSource;

  console.log(`   Original length: ${testSource.length}`);
  console.log(`   Materialized length: ${materialized.length}`);
  console.log(`   Roundtrip ${roundtripPassed ? '✓ PASSED' : '✗ FAILED'}`);

  if (!roundtripPassed) {
    console.log("\n   Diff (first 10 differences):");
    const origLines = testSource.split('\n');
    const printLines = materialized.split('\n');
    let diffs = 0;
    for (let i = 0; i < Math.max(origLines.length, printLines.length) && diffs < 10; i++) {
      if (origLines[i] !== printLines[i]) {
        console.log(`   Line ${i+1}:`);
        console.log(`     Orig: ${JSON.stringify(origLines[i] || '')}`);
        console.log(`     Print: ${JSON.stringify(printLines[i] || '')}`);
        diffs++;
      }
    }
  }

  console.log("\n5. Performance check...");
  const perfStart = performance.now();
  for (let i = 0; i < 100; i++) {
    symbolQuery(db, "greet");
  }
  const queryTime = (performance.now() - perfStart) / 100;
  console.log(`   Average query time: ${queryTime.toFixed(2)}ms (target: <500ms)`);

  console.log("\n6. Testing caller finding...");
  const callers = findCallers(db, "greet");
  console.log(`   Found ${callers.length} caller(s) for 'greet':`);
  for (const caller of callers) {
    console.log(`   - ${caller.filePath}:${caller.line} - ${caller.text}`);
  }
  
  const callerAccuracy = callers.length === 1 && callers[0]?.line === 8 ? '✓ PASS' : '✗ FAIL';
  console.log(`   Caller accuracy: ${callerAccuracy}`);

  console.log("\n7. Testing getSymbolWithReferences...");
  const greetSym = getSymbolWithReferences(db, "greet");
  if (greetSym) {
    console.log(`   Symbol: ${greetSym.name} (${greetSym.kind})`);
    console.log(`   Defined in: ${greetSym.filePath}`);
    console.log(`   Total references: ${greetSym.references.length}`);
    for (const ref of greetSym.references) {
      const marker = ref.isDefinition ? '[DEF]' : '     ';
      console.log(`   ${marker} ${ref.filePath}:${ref.line}:${ref.column}`);
    }
    
    const hasDef = greetSym.references.some(r => r.isDefinition);
    const hasCallers = greetSym.references.some(r => !r.isDefinition);
    console.log(`   Has definition: ${hasDef ? '✓' : '✗'}`);
    console.log(`   Has callers: ${hasCallers ? '✓' : '✗'}`);
  } else {
    console.log("   ✗ Symbol not found");
  }

  console.log("\n=== Phase 1 Results ===");
  console.log(`Hydration: ${hydrateTime < 30000 ? '✓ PASS' : '✗ FAIL'} (${hydrateTime.toFixed(2)}ms < 30s)`);
  console.log(`Roundtrip: ${roundtripPassed ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Query perf: ${queryTime < 500 ? '✓ PASS' : '✗ FAIL'} (${queryTime.toFixed(2)}ms < 500ms)`);

  console.log("\n=== Cross-file Reference Test ===");
  
  // Add a second file that imports and uses greet
  const secondFile = `import { greet } from './test';

export function welcome(user: string): string {
  return greet(user) + ' - welcome!';
}

function main() {
  console.log(welcome('Alice'));
}
`;
  
  hydrateSource(db, "second.ts", secondFile);
  
  const greetWithRefs = getSymbolWithReferences(db, "greet");
  if (greetWithRefs) {
    console.log(`   'greet' symbol found in ${new Set(greetWithRefs.references.map(r => r.filePath)).size} file(s)`);
    console.log(`   Total references: ${greetWithRefs.references.length}`);
    
    const files = new Set(greetWithRefs.references.map(r => r.filePath));
    console.log(`   Files: ${Array.from(files).join(', ')}`);
    
    const crossFileRefs = greetWithRefs.references.filter(r => r.filePath === 'second.ts');
    console.log(`   Cross-file references: ${crossFileRefs.length}`);
    
    for (const ref of greetWithRefs.references) {
      const marker = ref.isDefinition ? '[DEF]' : '     ';
      console.log(`   ${marker} ${ref.filePath}:${ref.line}:${ref.column}`);
    }
    
    // Validate cross-file tracking
    const hasDefInTestTs = greetWithRefs.references.some(r => r.isDefinition && r.filePath === 'test.ts');
    const hasImportInSecondTs = greetWithRefs.references.some(r => !r.isDefinition && r.filePath === 'second.ts' && r.line === 1);
    const hasCallInSecondTs = greetWithRefs.references.some(r => !r.isDefinition && r.filePath === 'second.ts' && r.line === 4);
    
    console.log(`\n   Cross-file validation:`);
    console.log(`     Definition in test.ts: ${hasDefInTestTs ? '✓' : '✗'}`);
    console.log(`     Import in second.ts:1: ${hasImportInSecondTs ? '✓' : '✗'}`);
    console.log(`     Call in second.ts:4: ${hasCallInSecondTs ? '✓' : '✗'}`);
  }

   console.log("\n=== Trace Ingestion Test ===");
   
   const sampleTraces = [
     {
       spanId: "span-001",
       parentSpanId: null,
       name: "HTTP GET /api/users",
       startTime: 1700000000000,
       endTime: 1700000050000,
       attributes: {
         "http.method": "GET",
         "http.url": "/api/users",
         "http.status_code": 200,
         "duration_ms": 45.2
       }
     },
     {
       spanId: "span-002",
       parentSpanId: "span-001",
       name: "SELECT * FROM users",
       startTime: 1700000000010,
       endTime: 1700000045000,
       attributes: {
         "db.system": "postgresql",
         "db.statement": "SELECT * FROM users WHERE id = ?",
         "duration_ms": 42.1
       }
     },
     {
       spanId: "span-003",
       parentSpanId: null,
       name: "HTTP POST /api/users",
       startTime: 1700000100000,
       endTime: 1700000125000,
       attributes: {
         "http.method": "POST",
         "http.url": "/api/users",
         "http.status_code": 201,
         "duration_ms": 120.5
       }
     },
     {
       spanId: "span-004",
       parentSpanId: "span-003",
       name: "INSERT INTO users",
       startTime: 1700000100020,
       endTime: 1700000124000,
       attributes: {
         "db.system": "postgresql",
         "db.statement": "INSERT INTO users (name, email) VALUES (?, ?)",
         "duration_ms": 118.3
       }
     },
     {
       spanId: "span-005",
       parentSpanId: null,
       name: "HTTP GET /api/users/123",
       startTime: 1700000200000,
       endTime: 1700000250000,
       attributes: {
         "http.method": "GET",
         "http.url": "/api/users/123",
         "http.status_code": 200,
         "duration_ms": 85.7
       }
     },
   ];
   
   console.log("1. Inserting sample traces...");
   const traceIds = insertTraces(db, sampleTraces);
   console.log(`   ✓ Inserted ${traceIds.length} trace spans`);
   console.log(`   IDs: ${traceIds.join(', ')}`);
   
   console.log("\n2. Querying all traces...");
   const allTraces = queryTraces(db, "SELECT * FROM traces ORDER BY start_time");
   console.log(`   Found ${allTraces.length} traces:`);
   for (const trace of allTraces) {
     const attrs = trace.attributes ? JSON.parse(String(trace.attributes)) : {};
     console.log(`   - ${trace.name} (${trace.span_id}): ${(attrs.duration_ms || 0).toFixed(1)}ms`);
   }
   
    console.log("\n3. Querying slow traces (>50ms)...");
    const slowTraceResults = queryTraces(db, `
      SELECT t.*, json_extract(t.attributes, '$.duration_ms') as duration
      FROM traces t
      WHERE json_extract(t.attributes, '$.duration_ms') > 50
      ORDER BY duration DESC
    `);
    console.log(`   Found ${slowTraceResults.length} slow trace(s):`);
    for (const trace of slowTraceResults) {
      const attrs = trace.attributes ? JSON.parse(String(trace.attributes)) : {};
      console.log(`   - ${trace.name}: ${(attrs.duration_ms || 0).toFixed(1)}ms`);
    }
   
    console.log("\n4. Querying DB queries only...");
    const dbTraces = queryTraces(db, `
      SELECT * FROM traces
      WHERE json_extract(attributes, '$."db.system"') IS NOT NULL
      ORDER BY start_time
    `);
   console.log(`   Found ${dbTraces.length} database trace(s):`);
   for (const trace of dbTraces) {
     const attrs = trace.attributes ? JSON.parse(String(trace.attributes)) : {};
     console.log(`   - ${trace.name}: ${(attrs as any)['db.statement'] || 'unknown query'}`);
   }
   
    console.log("\n5. Querying HTTP traces with status codes...");
    const httpTraces = queryTraces(db, `
      SELECT *, json_extract(attributes, '$."http.status_code"') as status
      FROM traces
      WHERE json_extract(attributes, '$."http.method"') IS NOT NULL
      ORDER BY start_time
    `);
   console.log(`   Found ${httpTraces.length} HTTP trace(s):`);
   for (const trace of httpTraces) {
     const attrs = trace.attributes ? JSON.parse(String(trace.attributes)) : {};
     console.log(`   - ${(attrs as any)['http.method']} ${(attrs as any)['http.url']}: ${(attrs as any)['http.status_code']}`);
   }
   
    console.log("\n6. Aggregation: average duration by span name...");
    const avgDurations = queryTraces(db, `
      SELECT name, AVG(json_extract(attributes, '$.duration_ms')) as avg_duration, COUNT(*) as count
      FROM traces
      WHERE json_extract(attributes, '$.duration_ms') IS NOT NULL
      GROUP BY name
      ORDER BY avg_duration DESC
    `);
    console.log(`   Average durations:`);
    for (const row of avgDurations) {
      console.log(`   - ${row.name}: ${(row as any).avg_duration?.toFixed(2) || 'N/A'}ms (${(row as any).count} samples)`);
    }

    console.log("\n=== Runtime + Structure Join Test ===");
    
    console.log("1. Resolving symbol IDs...");
    const greetSymbolId = resolveSymbolId(db, "greet");
    const sayHelloSymbolId = resolveSymbolId(db, "sayHello");
    console.log(`   greet symbol ID: ${greetSymbolId}`);
    console.log(`   sayHello symbol ID: ${sayHelloSymbolId}`);
    
    console.log("\n2. Inserting traces linked to symbols...");
    const tracedSpans = [
      {
        spanId: "trace-001",
        parentSpanId: null,
        name: "greet function call",
        startTime: 1700000300000,
        endTime: 1700000300050,
        attributes: { "duration_ms": 45.2, "input": "Alice" },
        symbolId: greetSymbolId
      },
      {
        spanId: "trace-002",
        parentSpanId: null,
        name: "greet function call",
        startTime: 1700000400000,
        endTime: 1700000400120,
        attributes: { "duration_ms": 118.5, "input": "Bob" },
        symbolId: greetSymbolId
      },
      {
        spanId: "trace-003",
        parentSpanId: null,
        name: "sayHello function call",
        startTime: 1700000500000,
        endTime: 1700000500200,
        attributes: { "duration_ms": 195.3 },
        symbolId: sayHelloSymbolId
      },
    ];
    const newTraceIds = insertTraces(db, tracedSpans);
    console.log(`   ✓ Inserted ${newTraceIds.length} trace(s) with symbol links`);
    
    console.log("\n3. Joining traces with symbols (all symbols with traces)...");
    const joinedResults = joinTracesWithSymbols(db);
    console.log(`   Found ${joinedResults.length} symbol(s) with trace data:`);
    for (const result of joinedResults) {
      console.log(`   - ${result.symbolName} (${result.symbolKind}) in ${result.filePath}`);
      console.log(`     Traces: ${result.traceCount}, Avg: ${(result.avgDurationMs || 0).toFixed(2)}ms, Max: ${(result.maxDurationMs || 0).toFixed(2)}ms`);
    }
    
    console.log("\n4. Finding slow traces (>100ms) with symbol info...");
    const slowTraces = findSlowTracesWithSymbols(db, 100);
    console.log(`   Found ${slowTraces.length} slow trace(s):`);
    for (const trace of slowTraces) {
      const symbolInfo = trace.symbolName ? `${trace.symbolName} (${trace.symbolKind}) in ${trace.filePath}` : "(no symbol link)";
      console.log(`   - ${trace.name}: ${(trace as any).durationMs?.toFixed(2) || 0}ms -> ${symbolInfo}`);
    }
    
    console.log("\n5. Performance audit scenario: find symbols averaging >50ms...");
    const slowSymbols = joinTracesWithSymbols(db, 50);
    console.log(`   Found ${slowSymbols.length} slow symbol(s):`);
    for (const sym of slowSymbols) {
      console.log(`   - ${sym.symbolName}: ${(sym.avgDurationMs || 0).toFixed(2)}ms avg (${sym.traceCount} calls)`);
    }

    console.log("\n=== Node Mutation + Materialization Test ===");
    
    console.log("1. Testing node_mutate (delete)...");
    const beforeDelete = materialize(db, "test.ts");
    console.log(`   Before delete: ${beforeDelete.length} chars`);
    
    // Find the variable declaration node for 'message'
    const messageSymbol = getSymbolWithReferences(db, "message");
    if (messageSymbol && messageSymbol.references.length > 0) {
        const defRef = messageSymbol.references.find(r => r.isDefinition);
        console.log(`   Found 'message' variable at ${defRef?.filePath}:${defRef?.line}`);
        
        // Find the node ID for this variable
        const varNodeQuery = db.prepare(`
            SELECT n.id FROM nodes n
            WHERE n.file_id = (SELECT id FROM files WHERE path = ?)
            AND n.kind = 'VariableDeclaration'
            AND json_extract(n.properties, '$.symbolName') = ?
        `);
        const varNode = varNodeQuery.get('test.ts', 'message') as { id: number } | undefined;
        
        if (varNode) {
            console.log(`   Variable node ID: ${varNode.id}`);
            
            // Get the parent (VariableStatement) to delete the whole statement
            const parentNodeQuery = db.prepare(`
                SELECT parent_id FROM nodes WHERE id = ?
            `);
            const parentNode = parentNodeQuery.get(varNode.id) as { parent_id: number | null } | undefined;
            console.log(`   Parent node ID: ${parentNode?.parent_id}`);
            
            // Delete the variable statement (parent of VariableDeclaration)
            if (parentNode?.parent_id) {
                const result = db.prepare(`
                    SELECT start, end FROM nodes WHERE id = ?
                `).get(parentNode.parent_id) as { start: number; end: number } | undefined;
                console.log(`   Parent node spans ${result?.start} to ${result?.end}`);
            }
        }
    }

    console.log("\n=== All Tests Complete ===");

    db.close();
}

main().catch(console.error);
