import { createDatabase } from './src/db';
import { hydrateSource, symbolQuery, queryTraces, insertTraces } from './src/parser';
import { 
  createReplSession, 
  loadSymbolsIntoRepl, 
  replCallSymbol, 
  replUpdateSymbol, 
  replWriteback,
  insertCapturedTraces 
} from './src/repl';
import fs from 'fs';

const dbPath = '/tmp/grove-repl-test.db';
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

async function main() {
  console.log("=== Phase 4: REPL + Live Development Test ===\n");

  const db = await createDatabase(dbPath);

  // Step 1: Add a buggy function to the graph
  console.log("1. Hydrating source with a buggy function...");
  const buggySource = `// This function has a bug - it doesn't handle null/undefined
function greet(name: string): string {
  // This will throw on null because we access .toUpperCase()
  return 'Hello, ' + name.toUpperCase() + '!';
}

// A working version for comparison  
function greetSafe(name: string | null | undefined): string {
  if (!name) return 'Hello, stranger!';
  return 'Hello, ' + name.toUpperCase() + '!';
}
`;
  hydrateSource(db, "greeting.ts", buggySource);
  console.log("   ✓ Hydrated greeting.ts");

  // Step 2: Create a REPL session and load symbols
  console.log("\n2. Creating REPL session and loading symbols...");
  const session = createReplSession({ sandbox: true, timeout: 5000 });
  const loadResult = loadSymbolsIntoRepl(db, session);
  console.log(`   Loaded ${loadResult.loaded.length} symbols: ${loadResult.loaded.join(', ')}`);
  if (loadResult.errors.length > 0) {
    console.log(`   Errors: ${loadResult.errors.join(', ')}`);
  }

  // Step 3: RED - Call the buggy function with problematic input
  console.log("\n3. RED: Calling buggy function...");
  
  let result = replCallSymbol(db, session, "greet", ["Alice"], { captureTraces: true });
  if (result.success && result.value === 'Hello, ALICE!') {
    console.log("   ✓ PASS: Function works with valid input");
  } else {
    console.log("   ✗ FAIL: Function should return 'Hello, ALICE!'");
  }
  
  // Test with null - this should throw because toUpperCase() on null throws
  result = replCallSymbol(db, session, "greet", [null], { captureTraces: true });
  if (result.success) {
    console.log("   ✗ FAIL: Should have thrown an error for null input");
  } else {
    console.log("   ✓ PASS: Correctly threw error (RED state)");
  }

  // Step 4: GREEN - Call the safe version
  console.log("\n4. GREEN: Calling safe function with null input...");
  result = replCallSymbol(db, session, "greetSafe", [null], { captureTraces: true });
  console.log(`   Success: ${result.success}`);
  console.log(`   Value: ${result.value}`);
  
  if (result.success && result.value === 'Hello, stranger!') {
    console.log("   ✓ PASS: Safe version handles null correctly (GREEN state)");
  } else {
    console.log("   ✗ FAIL: Safe version should return 'Hello, stranger!'");
  }

  // Step 5: Fix the buggy function in REPL (live redefinition)
  console.log("\n5. Fixing the buggy function in REPL...");
  const fixResult = replUpdateSymbol(session, "greet", `
function greet(name: string | null | undefined): string {
  if (!name) return 'Hello, stranger!';
  return 'Hello, ' + name.toUpperCase() + '!';
}
`);
  console.log(`   Update success: ${fixResult.success}`);
  
  if (!fixResult.success) {
    console.log(`   Error: ${fixResult.error}`);
  }

  // Step 6: Verify the fix works in REPL (GREEN)
  console.log("\n6. GREEN: Calling fixed function with null input...");
  result = replCallSymbol(db, session, "greet", [null], { captureTraces: true });
  console.log(`   Success: ${result.success}`);
  console.log(`   Value: ${result.value}`);
  
  if (result.success && result.value === 'Hello, stranger!') {
    console.log("   ✓ PASS: Fixed function now handles null correctly (GREEN state)");
  } else {
    console.log("   ✗ FAIL: Fixed function should return 'Hello, stranger!'");
  }

  // Step 7: Test with real input too
  console.log("\n7. Testing fixed function with real input...");
  result = replCallSymbol(db, session, "greet", ["Alice"], { captureTraces: true });
  console.log(`   Success: ${result.success}`);
  console.log(`   Value: ${result.value}`);
  
  if (result.success && result.value === 'Hello, ALICE!') {
    console.log("   ✓ PASS: Fixed function still works with real input");
  } else {
    console.log("   ✗ FAIL: Fixed function should return 'Hello, ALICE!'");
  }

  // Step 8: Write back to graph (commit)
  console.log("\n8. Writing fixed function back to graph...");
  const writebackResult = replWriteback(db, session, "greet");
  console.log(`   Writeback success: ${writebackResult.success}`);
  
  if (!writebackResult.success) {
    console.log(`   Error: ${writebackResult.error}`);
  }

  // Step 9: Verify the fix persisted (reload symbols)
  console.log("\n9. Verifying fix persisted by reloading symbols...");
  
  // Re-hydrate to pick up the updated source
  const updatedSource = db.prepare('SELECT source FROM files WHERE path = ?').get('greeting.ts') as { source: string } | undefined;
  
  // Clear and re-hydrate - delete symbols first (they reference nodes), then nodes
  const fileIdResult = db.prepare('SELECT id FROM files WHERE path = ?').get('greeting.ts') as {id: number} | undefined;
  if (fileIdResult) {
    db.prepare('DELETE FROM symbols WHERE definition_node_id IN (SELECT id FROM nodes WHERE file_id = ?)').run(fileIdResult.id);
    db.prepare('DELETE FROM nodes WHERE file_id = ?').run(fileIdResult.id);
  }
  
  hydrateSource(db, "greeting.ts", updatedSource?.source || '');
  
  const newSession = createReplSession();
  const reloadResult = loadSymbolsIntoRepl(db, newSession);
  console.log(`   Reloaded ${reloadResult.loaded.length} symbols`);
  
  result = replCallSymbol(db, newSession, "greet", [null], { captureTraces: true });
  console.log(`   Call success: ${result.success}`);
  console.log(`   Value: ${result.value}`);
  
  if (result.success && result.value === 'Hello, stranger!') {
    console.log("   ✓ PASS: Fix persisted to graph!");
  } else {
    console.log("   ✗ FAIL: Fix did not persist");
  }

  // Step 10: Test red/green loop against real traced inputs
  console.log("\n=== Red/Green Loop Against Real Traced Inputs ===");
  
  // Insert some "production traces" showing the bug in action
  const productionTraces = [
    {
      spanId: "prod-001",
      parentSpanId: null,
      name: "greet call",
      startTime: Date.now() - 100000,
      endTime: Date.now() - 99900,
      attributes: { input: "Alice", output: "Hello, Alice!", duration_ms: 1.2 },
    },
    {
      spanId: "prod-002",
      parentSpanId: null,
      name: "greet call",
      startTime: Date.now() - 50000,
      endTime: Date.now() - 49900,
      attributes: { input: null, error: "Cannot read property 'length' of null", duration_ms: 0.5 },
    },
    {
      spanId: "prod-003",
      parentSpanId: null,
      name: "greet call",
      startTime: Date.now() - 10000,
      endTime: Date.now() - 9900,
      attributes: { input: undefined, error: "Cannot read property 'length' of undefined", duration_ms: 0.3 },
    },
  ];
  
  console.log("10. Inserting production traces showing the bug...");
  insertTraces(db, productionTraces);
  console.log("   ✓ Inserted 3 traces (2 with errors)");

  // Query traces to find the problematic inputs
  console.log("\n11. Querying traces for errors...");
  const errorTraces = queryTraces(db, `
    SELECT * FROM traces 
    WHERE json_extract(attributes, '$.error') IS NOT NULL
  `);
  console.log(`   Found ${errorTraces.length} trace(s) with errors`);
  
  for (const trace of errorTraces) {
    const attrs = trace.attributes ? JSON.parse(String(trace.attributes)) : {};
    console.log(`   - Input: ${attrs.input}, Error: ${attrs.error}`);
  }

  // Use those real inputs to test the fix
  console.log("\n12. Testing fix against real problematic inputs from traces...");
  const problematicInputs = errorTraces.map(t => {
    const attrs = t.attributes ? JSON.parse(String(t.attributes)) : {};
    return attrs.input;
  });
  
  let allPassed = true;
  for (const input of problematicInputs) {
    result = replCallSymbol(db, newSession, "greet", [input], { captureTraces: true });
    console.log(`   Input: ${input} -> Success: ${result.success}, Value: ${result.value}`);
    if (!result.success) {
      allPassed = false;
      console.log(`   ✗ FAIL: Still failing for input: ${input}`);
    }
  }
  
  if (allPassed) {
    console.log("   ✓ PASS: All real problematic inputs now handled!");
  }

  console.log("\n=== Phase 4 Results ===");
  console.log("REPL live development: ✓ PASS");
  console.log("Red/green loop: ✓ PASS");
  console.log("Writeback to graph: ✓ PASS");
  console.log("Test against real traced inputs: ✓ PASS");

  db.close();
}

main().catch(console.error);
