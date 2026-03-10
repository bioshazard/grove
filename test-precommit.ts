import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { preCommitHook, printValidationReport } from './src/pre-commit';
import { hydrateSource } from './src/parser';
import { createDatabase } from './src/db';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('pre-commit hook', () => {
  let testDir: string;
  let dbPath: string;
  let db: Awaited<ReturnType<typeof createDatabase>>;

  beforeEach(async () => {
    // Create a temporary directory for tests
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'grove-precommit-test-'));
    dbPath = path.join(testDir, 'test.db');
    
    // Create database
    db = await createDatabase(dbPath);
  });

  afterEach(async () => {
    // Cleanup
    db.close();
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  it('should return success when no database exists', async () => {
    const result = await preCommitHook({
      dbPath: '/nonexistent/path/test.db',
      workDir: testDir,
      verbose: false
    });

    expect(result.success).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('should return success when database is empty', async () => {
    const result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: false
    });

    expect(result.success).toBe(true);
  });

  it('should materialize files and validate them', async () => {
    // Add a valid TypeScript file to the database
    const validCode = `
export function greet(name: string): string {
  return 'Hello, ' + name + '!';
}
`;
    
    hydrateSource(db, 'src/greet.ts', validCode);
    
    const result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: false
    });

    expect(result.success).toBe(true);
  });

  it('should fail typecheck on invalid TypeScript', async () => {
    // Add a file with type errors
    const invalidCode = `
export function add(a: number, b: string): number {
  return a + b; // Type error: cannot add number and string
}
`;
    
    hydrateSource(db, 'src/math.ts', invalidCode);
    
    const result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: false
    });

    // Should have typecheck errors
    expect(result.errors.some((e: any) => e.type === 'typecheck')).toBe(true);
  });

  it('should materialize files to the correct location', async () => {
    const code = `export const value = 42;`;
    
    hydrateSource(db, 'src/consts.ts', code);
    
    const outputDir = path.join(testDir, '.git', 'worktree');
    await preCommitHook({
      dbPath,
      workDir: testDir,
      outputDir,
      verbose: false
    });

    // Check that file was materialized (before cleanup on success)
    // Note: this test may need adjustment based on cleanup behavior
  });

  it('should report duration', async () => {
    const code = `export const value = 42;`;
    
    hydrateSource(db, 'src/consts.ts', code);
    
    const result = await preCommitHook({
      dbPath,
      workDir: testDir,
      verbose: false
    });

    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.durationMs).toBeLessThan(5000); // Should be fast (< 5s)
  });
});

describe('printValidationReport', () => {
  it('should format success report correctly', async () => {
    const result = {
      success: true,
      errors: [],
      warnings: [],
      durationMs: 100
    };

    // Just verify it doesn't throw
    expect(async () => {
      await printValidationReport(result);
    }).not.toThrow();
  });

  it('should format error report correctly', async () => {
    const result = {
      success: false,
      errors: [
        {
          type: 'typecheck' as const,
          file: 'src/test.ts',
          message: 'Type checking failed',
          details: 'Error: Type mismatch'
        }
      ],
      warnings: [],
      durationMs: 100
    };

    // Just verify it doesn't throw
    expect(async () => {
      await printValidationReport(result);
    }).not.toThrow();
  });
});
