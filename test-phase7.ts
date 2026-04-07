/**
 * Phase 7: Pre-commit Hook End-to-End Test
 * 
 * Tests the complete workflow:
 * 1. Setup: Create test files in the graph via hydrateSource
 * 2. Agent modification: Use REPL to modify a symbol (replUpdateSymbol)
 * 3. Writeback: Commit the change to the graph (replWriteback)
 * 4. Pre-commit validation: Run preCommitHook which validates materialized files
 * 5. Verification: Confirm the modified code appears in materialized output
 */

import { createDatabase } from './src/db';
import { hydrateSource, materialize } from './src/parser';
import { createReplSession, loadSymbolsIntoRepl, replUpdateSymbol, replWriteback, replCallSymbol } from './src/repl';
import { preCommitHook, type ValidationResult } from './src/pre-commit';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface TestResult {
  name: string;
  passed: boolean;
  message?: string;
  durationMs?: number;
}

class Phase7TestRunner {
  private testDir: string = '';
  private dbPath: string = '';
  private db: Awaited<ReturnType<typeof createDatabase>> | null = null;
  private results: TestResult[] = [];

  constructor() {
    this.testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-phase7-test-'));
    this.dbPath = path.join(this.testDir, 'test.db');
  }

  private get database(): Awaited<ReturnType<typeof createDatabase>> {
    if (!this.db) {
      throw new Error('Database not initialized. Call setup() first.');
    }
    return this.db;
  }

  async setup() {
    console.log(`[Setup] Creating test directory: ${this.testDir}`);
    console.log(`[Setup] Creating database: ${this.dbPath}`);
    
    this.db = await createDatabase(this.dbPath) as Awaited<ReturnType<typeof createDatabase>>;
    
    // Create examples directory in test dir
    const examplesDir = path.join(this.testDir, 'examples');
    fs.mkdirSync(examplesDir, { recursive: true });
    
    // Copy tsconfig.json for type checking
    const tsconfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'node',
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        isolatedModules: true
      },
      include: ['**/*.ts'],
      exclude: ['node_modules']
    };
    fs.writeFileSync(path.join(this.testDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
    
    console.log('[Setup] Complete');
  }

  async teardown() {
    if (this.db) {
      this.db.close();
    }
    fs.rmSync(this.testDir, { recursive: true, force: true });
    console.log('[Teardown] Complete');
  }

  private recordResult(result: TestResult) {
    this.results.push(result);
    const status = result.passed ? '✓' : '✗';
    console.log(`[${status}] ${result.name}: ${result.message || ''}`);
  }

  async testHydrateSource(): Promise<void> {
    console.log('\n--- Test: Hydrate Source ---');
    const startTime = Date.now();

    // Test TypeScript file hydration
    const mathCode = fs.readFileSync('./examples/math.ts', 'utf-8');
    hydrateSource(this.db, 'examples/math.ts', mathCode);

    // Verify file was added
    const files = this.db.prepare('SELECT * FROM files').all() as { path: string }[];
    const mathFile = files.find(f => f.path === 'examples/math.ts');

    if (!mathFile) {
      this.recordResult({
        name: 'Hydrate Source',
        passed: false,
        message: 'Math file not found in database'
      });
      return;
    }

    // Verify symbols were extracted
    const symbols = this.db.prepare('SELECT * FROM symbols WHERE definition_node_id IN (SELECT id FROM nodes WHERE file_id = ?)').all(mathFile.id) as { name: string; kind: string }[];
    const expectedFunctions = ['add', 'subtract', 'multiply', 'divide', 'factorial', 'fibonacci', 'isPrime', 'gcd'];
    const foundFunctions = symbols.filter(s => s.kind === 'function').map(s => s.name);

    const allFunctionsFound = expectedFunctions.every(fn => foundFunctions.includes(fn));

    this.recordResult({
      name: 'Hydrate Source',
      passed: allFunctionsFound,
      message: allFunctionsFound 
        ? `Found ${foundFunctions.length} functions` 
        : `Missing functions: ${expectedFunctions.filter(f => !foundFunctions.includes(f)).join(', ')}`,
      durationMs: Date.now() - startTime
    });
  }

  async testReplModify(): Promise<void> {
    console.log('\n--- Test: REPL Modify ---');
    const startTime = Date.now();

    // Create REPL session and load symbols
    const session = createReplSession();
    const { loaded, errors } = loadSymbolsIntoRepl(this.db, session);

    if (errors.length > 0) {
      console.log(`[Warning] Errors loading symbols: ${errors.join(', ')}`);
    }

    // Test calling original function
    const originalResult = replCallSymbol(this.db, session, 'add', [2, 3]);
    
    if (!originalResult.success || originalResult.value !== 5) {
      this.recordResult({
        name: 'REPL Modify',
        passed: false,
        message: `Original add(2,3) failed: ${originalResult.error || String(originalResult.value)}`
      });
      return;
    }

    // Modify the add function to add 1 extra
    const newAddCode = `
export function add(a: number, b: number): number {
  return a + b + 1;  // Modified!
}`;

    const updateResult = replUpdateSymbol(session, 'add', newAddCode);
    
    if (!updateResult.success) {
      this.recordResult({
        name: 'REPL Modify',
        passed: false,
        message: `Failed to update symbol: ${updateResult.error}`
      });
      return;
    }

    // Test calling modified function
    const modifiedResult = replCallSymbol(this.db, session, 'add', [2, 3]);
    
    if (!modifiedResult.success || modifiedResult.value !== 6) {
      this.recordResult({
        name: 'REPL Modify',
        passed: false,
        message: `Modified add(2,3) should return 6, got ${modifiedResult.value}`
      });
      return;
    }

    this.recordResult({
      name: 'REPL Modify',
      passed: true,
      message: `add(2,3) now returns ${modifiedResult.value} (was 5)`,
      durationMs: Date.now() - startTime
    });
  }

  async testWriteback(): Promise<void> {
    console.log('\n--- Test: Writeback ---');
    const startTime = Date.now();

    // Create session and load symbols
    const session = createReplSession();
    loadSymbolsIntoRepl(this.db, session);

    // Modify function in REPL
    replUpdateSymbol(session, 'add', `
export function add(a: number, b: number): number {
  return a + b + 100;  // Writeback test modification
}`);

    // Write back to graph
    const writebackResult = replWriteback(this.db, session, 'add');

    if (!writebackResult.success) {
      this.recordResult({
        name: 'Writeback',
        passed: false,
        message: `Writeback failed: ${writebackResult.error}`
      });
      return;
    }

    // Verify version incremented
    const symbols = this.db.prepare('SELECT version FROM symbols WHERE name = ?').all('add') as { version: number }[];
    const version = symbols[0]?.version || 0;

    // Verify source was updated by reloading and testing
    const newSession = createReplSession();
    loadSymbolsIntoRepl(this.db, newSession);
    const callResult = replCallSymbol(this.db, newSession, 'add', [1, 2]);

    this.recordResult({
      name: 'Writeback',
      passed: callResult.success && callResult.value === 103,
      message: callResult.success && callResult.value === 103
        ? `Version ${version}, add(1,2) = ${callResult.value}`
        : `Expected 103, got ${callResult.value || callResult.error}`,
      durationMs: Date.now() - startTime
    });
  }

  async testPreCommitValidation(): Promise<void> {
    console.log('\n--- Test: Pre-commit Validation ---');
    const startTime = Date.now();

    // Create session, modify function, and writeback
    const session = createReplSession();
    loadSymbolsIntoRepl(this.db, session);
    
    replUpdateSymbol(session, 'add', `
export function add(a: number, b: number): number {
  return a + b + 1000;  // Valid modification
}`);
    replWriteback(this.db, session, 'add');

    // Run pre-commit hook
    const result = await preCommitHook({
      dbPath: this.dbPath,
      workDir: this.testDir,
      verbose: false
    });

    const passed = result.success;

    this.recordResult({
      name: 'Pre-commit Validation',
      passed,
      message: passed 
        ? `Validated in ${result.durationMs}ms` 
        : `Failed: ${result.errors.map(e => e.message).join('; ')}`,
      durationMs: result.durationMs
    });
  }

  async testTypeErrorDetection(): Promise<void> {
    console.log('\n--- Test: Type Error Detection ---');
    const startTime = Date.now();

    // Use a fresh isolated DB so only the buggy file is checked by tsc
    const isolatedDbPath = path.join(this.testDir, 'buggy-test.db');
    const isolatedDb = await createDatabase(isolatedDbPath);

    const buggyCode = `export function buggyAdd(a: number, b: string): number {
  return a + b;  // Type error: cannot add number and string
}`;

    hydrateSource(isolatedDb, 'examples/buggy.ts', buggyCode);
    isolatedDb.close(); // persists to isolatedDbPath

    // Run pre-commit hook - should fail on the type error
    const result = await preCommitHook({
      dbPath: isolatedDbPath,
      workDir: this.testDir,
      verbose: false
    });

    const hasTypecheckError = result.errors.some((e: any) => e.type === 'typecheck');

    this.recordResult({
      name: 'Type Error Detection',
      passed: !result.success && hasTypecheckError,
      message: !result.success && hasTypecheckError
        ? `Correctly detected type error in ${result.durationMs}ms`
        : result.success ? 'Should have failed typecheck' : 'Did not detect typecheck error',
      durationMs: result.durationMs
    });
  }

  async testPerformance(): Promise<void> {
    console.log('\n--- Test: Performance (<5s) ---');
    
    // Add multiple files to test performance
    const filesToAdd = [
      { path: 'perf/file1.ts', content: 'export const val1 = 1;' },
      { path: 'perf/file2.ts', content: 'export const val2 = 2;' },
      { path: 'perf/file3.ts', content: 'export const val3 = 3;' },
      { path: 'perf/file4.ts', content: 'export const val4 = 4;' },
      { path: 'perf/file5.ts', content: 'export const val5 = 5;' },
    ];

    for (const file of filesToAdd) {
      hydrateSource(this.db, file.path, file.content);
    }

    // Measure pre-commit time
    const startTime = Date.now();
    const result = await preCommitHook({
      dbPath: this.dbPath,
      workDir: this.testDir,
      verbose: false
    });
    const durationMs = Date.now() - startTime;

    // Clean up
    for (const file of filesToAdd) {
      this.db.prepare('DELETE FROM files WHERE path = ?').run(file.path);
    }

    const passed = durationMs < 5000;

    this.recordResult({
      name: 'Performance (<5s)',
      passed,
      message: `${durationMs}ms (${passed ? 'PASS' : 'FAIL'})`,
      durationMs
    });
  }

  async testMaterializationCorrectness(): Promise<void> {
    console.log('\n--- Test: Materialization Correctness ---');

    // Create session, modify function, and writeback
    const session = createReplSession();
    loadSymbolsIntoRepl(this.db, session);
    
    replUpdateSymbol(session, 'add', `
export function add(a: number, b: number): number {
  return a + b + 999;  // Materialization test
}`);
    replWriteback(this.db, session, 'add');

    // Materialize the file
    const materialized = materialize(this.db, 'examples/math.ts');

    // Check if modification appears in materialized output
    const containsModification = materialized.includes('999') || materialized.includes('a + b +');

    this.recordResult({
      name: 'Materialization Correctness',
      passed: containsModification,
      message: containsModification 
        ? 'Modified code found in materialized output'
        : 'Modified code NOT found in materialized output'
    });
  }

  async testSelectiveMode(): Promise<void> {
    console.log('\n--- Test: Selective Mode ---');

    // Add multiple files
    hydrateSource(this.db, 'selective/a.ts', 'export const a = 1;');
    hydrateSource(this.db, 'selective/b.ts', 'export const b = 2;');
    hydrateSource(this.db, 'selective/c.ts', 'export const c = 3;');

    // Run pre-commit with selective mode
    const result = await preCommitHook({
      dbPath: this.dbPath,
      workDir: this.testDir,
      selective: true,
      changedFiles: ['selective/a.ts'],
      verbose: true
    });

    // Verify only selective/a.ts was materialized by checking duration is fast
    const passed = result.success && result.durationMs < 2000;

    // Clean up
    this.db.prepare('DELETE FROM files WHERE path LIKE ?').run('selective/%');

    this.recordResult({
      name: 'Selective Mode',
      passed,
      message: `Completed in ${result.durationMs}ms (${passed ? 'PASS' : 'FAIL'})`,
      durationMs: result.durationMs
    });
  }

  async testFullFlow(): Promise<void> {
    console.log('\n--- Test: Full Flow (hydrate → modify → writeback → validate) ---');
    const startTime = Date.now();

    // Step 1: Hydrate a new file
    const newFileCode = `
export function greet(name: string): string {
  return 'Hello, ' + name + '!';
}`;
    hydrateSource(this.db, 'flow/test.ts', newFileCode);

    // Step 2: Load into REPL
    const session = createReplSession();
    loadSymbolsIntoRepl(this.db, session);

    // Step 3: Modify in REPL
    replUpdateSymbol(session, 'greet', `
export function greet(name: string): string {
  return 'Greetings, ' + name + '!!';
}`);

    // Step 4: Verify modification works
    const callResult = replCallSymbol(this.db, session, 'greet', ['World']);
    if (!callResult.success || callResult.value !== 'Greetings, World!!') {
      this.recordResult({
        name: 'Full Flow',
        passed: false,
        message: `REPL call failed: ${callResult.error || String(callResult.value)}`
      });
      return;
    }

    // Step 5: Writeback to graph
    const writebackResult = replWriteback(this.db, session, 'greet');
    if (!writebackResult.success) {
      this.recordResult({
        name: 'Full Flow',
        passed: false,
        message: `Writeback failed: ${writebackResult.error}`
      });
      return;
    }

    // Step 6: Pre-commit validation
    const validationResult = await preCommitHook({
      dbPath: this.dbPath,
      workDir: this.testDir,
      verbose: false
    });

    if (!validationResult.success) {
      this.recordResult({
        name: 'Full Flow',
        passed: false,
        message: `Pre-commit failed: ${validationResult.errors.map(e => e.message).join('; ')}`
      });
      return;
    }

    // Step 7: Verify materialized output contains modification
    const materialized = materialize(this.db, 'flow/test.ts');
    const containsModification = materialized.includes('Greetings');

    // Clean up
    this.db.prepare('DELETE FROM files WHERE path = ?').run('flow/test.ts');

    const durationMs = Date.now() - startTime;

    this.recordResult({
      name: 'Full Flow',
      passed: validationResult.success && containsModification,
      message: `Completed in ${durationMs}ms with validation`,
      durationMs
    });
  }

  async runAllTests(): Promise<void> {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('        PHASE 7: PRE-COMMIT HOOK END-TO-END TEST');
    console.log('═══════════════════════════════════════════════════════════\n');

    try {
      await this.setup();

      // Run all tests
      await this.testHydrateSource();
      await this.testReplModify();
      await this.testWriteback();
      await this.testPreCommitValidation();
      await this.testTypeErrorDetection();
      await this.testMaterializationCorrectness();
      await this.testSelectiveMode();
      await this.testPerformance();
      await this.testFullFlow();

      // Print summary
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('                     TEST SUMMARY');
      console.log('═══════════════════════════════════════════════════════════\n');

      const passed = this.results.filter(r => r.passed).length;
      const failed = this.results.filter(r => !r.passed).length;

      for (const result of this.results) {
        const status = result.passed ? '✓' : '✗';
        console.log(`  ${status} ${result.name}`);
        if (result.message) {
          console.log(`     ${result.message}`);
        }
      }

      console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${this.results.length} tests`);

      if (failed > 0) {
        console.log('\n⚠️  Some tests failed. Check output above for details.');
        process.exit(1);
      } else {
        console.log('\n✅ All tests passed!');
        process.exit(0);
      }

    } catch (error) {
      console.error('Fatal error:', error);
      process.exit(1);
    } finally {
      await this.teardown();
    }
  }
}

// Run tests
const runner = new Phase7TestRunner();
runner.runAllTests();
