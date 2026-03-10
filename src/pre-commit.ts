import { createDatabase } from './db';
import { materialize, getAllSymbols } from './parser';
import fs from 'fs';
import path from 'path';

export interface PreCommitOptions {
  dbPath?: string;
  workDir?: string;
  outputDir?: string;
  verbose?: boolean;
}

export interface ValidationResult {
  success: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  durationMs: number;
}

export interface ValidationError {
  type: 'typecheck' | 'lint' | 'materialize' | 'file-system';
  file?: string;
  message: string;
  details?: string;
}

export interface ValidationWarning {
  type: string;
  message: string;
}

export async function preCommitHook(options: PreCommitOptions = {}): Promise<ValidationResult> {
  const startTime = Date.now();
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  
  const dbPath = options.dbPath || process.env.GROVE_DB_PATH || '/tmp/grove-mcp.db';
  const workDir = options.workDir || process.cwd();
  const outputDir = options.outputDir || path.join(workDir, '.git', 'worktree');
  
  const verbose = options.verbose || false;
  
  if (verbose) {
    console.log(`[pre-commit] Starting validation...`);
    console.log(`[pre-commit] DB path: ${dbPath}`);
    console.log(`[pre-commit] Work dir: ${workDir}`);
    console.log(`[pre-commit] Output dir: ${outputDir}`);
  }

  // Check if database exists
  if (!fs.existsSync(dbPath)) {
    if (verbose) {
      console.log(`[pre-commit] No database found at ${dbPath}, skipping validation`);
    }
    return {
      success: true,
      errors: [],
      warnings: [{ type: 'info', message: 'No grove database found, validation skipped' }],
      durationMs: Date.now() - startTime
    };
  }

  // Open database
  let db;
  try {
    db = await createDatabase(dbPath);
    if (verbose) {
      console.log(`[pre-commit] Database opened successfully`);
    }
  } catch (err: any) {
    errors.push({
      type: 'file-system',
      message: `Failed to open database: ${err.message}`,
      details: err.stack
    });
    return {
      success: false,
      errors,
      warnings,
      durationMs: Date.now() - startTime
    };
  }

  // Get all files from the graph
  const files = db.prepare(`
    SELECT id, path, source, language
    FROM files
  `).all() as { id: number; path: string; source: string; language: string }[];

  if (files.length === 0) {
    db.close();
    if (verbose) {
      console.log(`[pre-commit] No files in database, skipping validation`);
    }
    return {
      success: true,
      errors: [],
      warnings: [{ type: 'info', message: 'No files in database, validation skipped' }],
      durationMs: Date.now() - startTime
    };
  }

  if (verbose) {
    console.log(`[pre-commit] Found ${files.length} files in database`);
  }

  // Create output directory
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err: any) {
    errors.push({
      type: 'file-system',
      message: `Failed to create worktree directory: ${err.message}`,
      details: err.stack
    });
    db.close();
    return {
      success: false,
      errors,
      warnings,
      durationMs: Date.now() - startTime
    };
  }

  // Create tsconfig.json in worktree for type checking
  const tsconfigPath = path.join(outputDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
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
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
  }

  // Materialize all files to disk
  let materializedCount = 0;
  for (const file of files) {
    try {
      const sourceText = materialize(db, file.path);
      if (!sourceText) {
        warnings.push({
          type: 'materialize',
          message: `Empty materialization for ${file.path}`
        });
        continue;
      }

      // Compute output path relative to worktree root
      const outputPath = path.join(outputDir, file.path);
      const outputDirPath = path.dirname(outputPath);
      
      fs.mkdirSync(outputDirPath, { recursive: true });
      fs.writeFileSync(outputPath, sourceText, 'utf-8');
      materializedCount++;
      
      if (verbose) {
        console.log(`[pre-commit] Materialized: ${file.path}`);
      }
    } catch (err: any) {
      errors.push({
        type: 'materialize',
        file: file.path,
        message: `Failed to materialize file: ${err.message}`,
        details: err.stack
      });
    }
  }

  if (verbose) {
    console.log(`[pre-commit] Materialized ${materializedCount} files to ${outputDir}`);
  }

  // Read package.json to find available scripts
  const packageJsonPath = path.join(workDir, 'package.json');
  let scripts: Record<string, string> = {};
  
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      scripts = packageJson.scripts || {};
      if (verbose) {
        console.log(`[pre-commit] Available scripts: ${Object.keys(scripts).join(', ')}`);
      }
    } catch (err: any) {
      warnings.push({
        type: 'file-system',
        message: `Failed to read package.json: ${err.message}`
      });
    }
  }

  // Run typecheck if available
  const typecheckScript = scripts.typecheck || scripts['type-check'];
  if (typecheckScript) {
    if (verbose) {
      console.log(`[pre-commit] Running typecheck: ${typecheckScript}`);
    }
    
    const typecheckResult = await runValidationCommand(
      extractBunCommand(typecheckScript),
      workDir
    );
    
    if (!typecheckResult.success) {
      errors.push({
        type: 'typecheck',
        message: `Type checking failed`,
        details: typecheckResult.output
      });
    }
  } else {
    // Fallback to tsc directly
    if (verbose) {
      console.log(`[pre-commit] Running tsc --noEmit`);
    }
    
    const tscResult = await runValidationCommand(
      ['tsc', ['--noEmit']],
      workDir
    );
    
    if (!tscResult.success && tscResult.code !== 127) { // 127 = command not found
      errors.push({
        type: 'typecheck',
        message: `Type checking failed`,
        details: tscResult.output
      });
    }
  }

  // Run lint if available
  const lintScript = scripts.lint;
  if (lintScript) {
    if (verbose) {
      console.log(`[pre-commit] Running lint: ${lintScript}`);
    }
    
    const lintResult = await runValidationCommand(
      extractBunCommand(lintScript),
      workDir
    );
    
    if (!lintResult.success) {
      errors.push({
        type: 'lint',
        message: `Linting failed`,
        details: lintResult.output
      });
    }
  }

  // Run tests if available (optional, configurable)
  const testScript = scripts.test;
  if (testScript && process.env.RUN_PRECOMMIT_TESTS === 'true') {
    if (verbose) {
      console.log(`[pre-commit] Running tests: ${testScript}`);
    }
    
    const testResult = await runValidationCommand(
      extractBunCommand(testScript),
      workDir,
      30000 // 30s timeout for tests
    );
    
    if (!testResult.success) {
      errors.push({
        type: 'lint',
        message: `Tests failed`,
        details: testResult.output
      });
    }
  }

  // Cleanup worktree on success only
  if (errors.length === 0) {
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
      if (verbose) {
        console.log(`[pre-commit] Cleaned up worktree`);
      }
    } catch (err: any) {
      warnings.push({
        type: 'file-system',
        message: `Failed to cleanup worktree: ${err.message}`
      });
    }
  } else {
    if (verbose) {
      console.log(`[pre-commit] Left worktree at ${outputDir} for debugging`);
    }
  }

  db.close();

  const durationMs = Date.now() - startTime;
  
  if (verbose) {
    console.log(`[pre-commit] Validation completed in ${durationMs}ms`);
  }

  return {
    success: errors.length === 0,
    errors,
    warnings,
    durationMs
  };
}

function extractBunCommand(script: string): [string, string[]] {
  // Parse bun run script format
  const match = script.match(/^bun\s+run\s+(.+)$/);
  if (match && match[1]) {
    const cmdAndArgs = match[1].split(' ');
    const cmd = cmdAndArgs[0] || 'bun';
    return [cmd, cmdAndArgs.slice(1)];
  }
  
  // Fallback: treat as bun run <script-name>
  return ['bun', ['run', String(script)]];
}

interface CommandResult {
  success: boolean;
  code: number;
  output: string;
}

async function runValidationCommand(
  commandParts: [string, string[]],
  cwd: string,
  timeout: number = 10000
): Promise<CommandResult> {
  const [command, args] = commandParts;
  
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        code: -1,
        output: `Command timed out after ${timeout}ms\n${stdout}\n${stderr}`
      });
    }, timeout);

    proc.on('close', (code: number) => {
      clearTimeout(timer);
      const output = stdout + stderr;
      resolve({
        success: code === 0,
        code: code || -1,
        output
      });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        success: false,
        code: -1,
        output: `Command failed to start: ${err.message}`
      });
    });
  });
}

export async function printValidationReport(result: ValidationResult): Promise<void> {
  const { success, errors, warnings, durationMs } = result;
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('              GROVE PRE-COMMIT VALIDATION');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Summary
  if (success) {
    console.log('✓ All validations passed');
  } else {
    console.log('✗ Validation failed with errors');
  }
  
  console.log(`  Duration: ${durationMs}ms`);
  console.log('');

  // Errors
  if (errors.length > 0) {
    console.log('ERRORS:');
    console.log('───────────────────────────────────────────────────────────────');
    
    for (const error of errors) {
      const typeLabel = error.type.toUpperCase();
      console.log(`[${typeLabel}] ${error.message}`);
      
      if (error.file) {
        console.log(`  File: ${error.file}`);
      }
      
      if (error.details) {
        // Format details nicely
        const lines = error.details.split('\n').slice(0, 20);
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        if (error.details.split('\n').length > 20) {
          console.log(`  ... (${error.details.split('\n').length - 20} more lines)`);
        }
      }
      console.log('');
    }
  }

  // Warnings
  if (warnings.length > 0) {
    console.log('WARNINGS:');
    console.log('───────────────────────────────────────────────────────────────');
    
    for (const warning of warnings) {
      console.log(`[${warning.type?.toUpperCase() || 'WARN'}] ${warning.message}`);
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

// CLI entry point
if (import.meta.main) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const result = await preCommitHook({ verbose });
  await printValidationReport(result);
  
  process.exit(result.success ? 0 : 1);
}
