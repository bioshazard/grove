import { createDatabase } from './src/db';
import { hydrateSource, materialize } from './src/parser';
import fs from 'fs';

const dbPath = '/tmp/grove-debug.db';
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

async function main() {
  // This is the exact source from index.ts
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

  console.log("Original:");
  console.log(JSON.stringify(testSource));
  console.log("Length:", testSource.length);
  console.log("Last char code:", testSource.charCodeAt(testSource.length - 1));
  console.log("");

  const db = await createDatabase(dbPath);
  hydrateSource(db, "test.ts", testSource);
  
  const materialized = materialize(db, "test.ts");
  
  console.log("Materialized:");
  console.log(JSON.stringify(materialized));
  console.log("Length:", materialized.length);
  console.log("Last char code:", materialized.charCodeAt(materialized.length - 1));
  console.log("");

  console.log("Match:", testSource === materialized);
  
  if (testSource !== materialized) {
    console.log("\nChar-by-char diff:");
    const maxLen = Math.max(testSource.length, materialized.length);
    for (let i = 0; i < maxLen; i++) {
      const origChar = testSource[i];
      const matChar = materialized[i];
      if (origChar !== matChar) {
        console.log(`Position ${i}: orig=${JSON.stringify(origChar)} (${origChar?.charCodeAt(0)}), mat=${JSON.stringify(matChar)} (${matChar?.charCodeAt(0)})`);
        if (i > 50) break;
      }
    }
    
    console.log("\nLine-by-line diff:");
    const origLines = testSource.split('\n');
    const matLines = materialized.split('\n');
    for (let i = 0; i < Math.max(origLines.length, matLines.length); i++) {
      if (origLines[i] !== matLines[i]) {
        console.log(`Line ${i+1}: orig=${JSON.stringify(origLines[i])}, mat=${JSON.stringify(matLines[i])}`);
      }
    }
  }

  db.close();
}

main().catch(console.error);
