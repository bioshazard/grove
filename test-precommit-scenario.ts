import { createDatabase } from './src/db';
import { hydrateSource } from './src/parser';
import { preCommitHook, printValidationReport } from './src/pre-commit';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function runTestScenario() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     PRE-COMMIT HOOK TEST SCENARIO');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Create a temporary directory for the test
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'grove-test-'));
  const dbPath = path.join(testDir, 'test.db');
  
  console.log(`Test directory: ${testDir}`);
  console.log(`Database path: ${dbPath}\n`);

  try {
    // Create database
    let db = await createDatabase(dbPath);

    // Scenario 1: Valid TypeScript file - should pass
    console.log('--- Scenario 1: Valid TypeScript file ---');
    const validCode = `
export function greet(name: string): string {
  return 'Hello, ' + name + '!';
}

export interface User {
  id: number;
  name: string;
}
`;
    hydrateSource(db, 'src/greet.ts', validCode);
    db.save(dbPath); // Persist to disk
    
    // Re-open database for fresh read
    db.close();
    db = await createDatabase(dbPath);
    
    let result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: true
    });
    
    console.log('\nResult:', result.success ? 'PASS ✓' : 'FAIL ✗');
    console.log('Errors:', result.errors.length);
    console.log('Duration:', result.durationMs, 'ms\n');

    // Scenario 2: TypeScript file with type errors - should fail
    console.log('\n--- Scenario 2: TypeScript file with type errors ---');
    const invalidCode = `
export function add(a: number, b: number): number {
  // Intentional type error: returning string instead of number
  return 'not a number';
}

export function multiply(x: number, y: string): number {
  // Intentional type error: cannot multiply number by string
  return x * y;
}
`;
    hydrateSource(db, 'src/math.ts', invalidCode);
    db.save(dbPath);
    db.close();
    db = await createDatabase(dbPath);
    
    result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: true
    });
    
    console.log('\nResult:', result.success ? 'PASS ✓' : 'FAIL ✗');
    console.log('Errors:', result.errors.length);
    
    if (result.errors.length > 0) {
      console.log('\nError details:');
      for (const error of result.errors) {
        console.log(`  [${error.type.toUpperCase()}] ${error.message}`);
        if (error.details) {
          const lines = error.details.split('\n').slice(0, 5);
          for (const line of lines) {
            console.log(`    ${line}`);
          }
        }
      }
    }
    console.log('Duration:', result.durationMs, 'ms\n');

    // Scenario 3: Multiple files, some valid, some invalid
    console.log('\n--- Scenario 3: Mixed valid and invalid files ---');
    const anotherValidCode = `
export const PI = 3.14159;
export const E = 2.71828;
`;
    hydrateSource(db, 'src/constants.ts', anotherValidCode);
    db.save(dbPath);
    db.close();
    db = await createDatabase(dbPath);
    
    result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: true
    });
    
    console.log('\nResult:', result.success ? 'PASS ✓' : 'FAIL ✗');
    console.log('Errors:', result.errors.length);
    console.log('Duration:', result.durationMs, 'ms\n');

    // Scenario 4: Performance test - many files
    console.log('\n--- Scenario 4: Performance test (20 files) ---');
    const perfStart = Date.now();
    
    for (let i = 0; i < 20; i++) {
      const perfCode = `
export function func${i}(x: number): number {
  return x + ${i};
}
`;
      hydrateSource(db, `src/module${i}.ts`, perfCode);
    }
    db.save(dbPath);
    db.close();
    db = await createDatabase(dbPath);
    
    result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: false
    });
    
    const perfDuration = Date.now() - perfStart;
    console.log('Total time (hydrate + validate):', perfDuration, 'ms');
    console.log('Validation only:', result.durationMs, 'ms');
    console.log('Result:', result.success ? 'PASS ✓' : 'FAIL ✗');
    console.log('Errors:', result.errors.length);

    db.close();
    
  } finally {
    // Cleanup
    await fs.promises.rm(testDir, { recursive: true, force: true });
    console.log('\nCleaned up test directory');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('     TEST SCENARIO COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
}

runTestScenario().catch(console.error);
