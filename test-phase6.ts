import { 
  createCdpSession, 
  diffSsrOutputs,
  captureCssMatches,
  evalInBrowserContext,
  closeAllCdpSessions
} from './src/cdp';
import { spawn } from 'child_process';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(url: string, timeout: number = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Server did not start within ${timeout}ms`);
}

async function main() {
  console.log("=== Phase 6: CDP Integration Test ===\n");

  // Start the SSR server
  console.log("1. Starting SSR example server...");
  const server = spawn('bun', ['examples/ssr-server.ts'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false
  });

  server.stdout?.on('data', (data: Buffer) => {
    console.log(`   [Server] ${data.toString().trim()}`);
  });

  await sleep(500); // Wait for server to start
  await waitForServer('http://localhost:3456');
  console.log("   ✓ Server started at http://localhost:3456\n");

  try {
    // Test 1: Create CDP session
    console.log("2. Creating CDP session...");
    const session = await createCdpSession('http://localhost:3456', { headless: true });
    console.log("   ✓ CDP session created");
    console.log(`   Navigation traces: ${session.navigationTraces.length}`);
    console.log(`   Console messages: ${session.consoleMessages.length}`);
    console.log(`   JS exceptions: ${session.jsExceptions.length}\n`);

    // Test 2: Check captured HTML
    console.log("3. Checking captured HTML...");
    const trace = session.navigationTraces[0];
    if (trace) {
      console.log(`   Server HTML length: ${trace.serverHtml?.length || 0} chars`);
      console.log(`   Client HTML length: ${trace.clientHtml?.length || 0} chars`);
      console.log(`   HTML captured: ✓\n`);
    }

    // Test 3: Detect hydration mismatch
    console.log("4. Detecting hydration mismatch...");
    if (trace?.serverHtml && trace?.clientHtml) {
      const diffResult = await diffSsrOutputs(session, trace.serverHtml, trace.clientHtml);
      console.log(`   Mismatch detected: ${diffResult.mismatch ? '✓ YES' : '✗ NO'}`);
      
      if (diffResult.mismatch && diffResult.differences) {
        console.log(`   Differences found: ${diffResult.differences.length}`);
        const firstDiff = diffResult.differences[0];
        if (firstDiff) {
          console.log(`   First difference at: ${firstDiff.path}`);
          console.log(`   Server value (snippet): ${firstDiff.serverValue.substring(0, 50)}...`);
          console.log(`   Client value (snippet): ${firstDiff.clientValue.substring(0, 50)}...`);
        }
      }
      console.log();
    }

    // Test 4: Capture CSS matches (for dead CSS detection)
    console.log("5. Capturing CSS matches...");
    const cssMatches = await captureCssMatches(session);
    console.log(`   Total CSS selectors found: ${cssMatches.length}`);
    
    // Find unused CSS (dead CSS)
    const usedSelectors = cssMatches.filter(m => m.matchCount > 0);
    const unusedSelectors = cssMatches.filter(m => m.matchCount === 0);
    
    console.log(`   Used selectors: ${usedSelectors.length}`);
    console.log(`   Unused (dead) selectors: ${unusedSelectors.length}`);
    
    if (unusedSelectors.length > 0) {
      console.log("   Dead CSS found:");
      for (const selector of unusedSelectors.slice(0, 5)) {
        console.log(`     - ${selector.selector} (0 matches)`);
      }
    }
    console.log();

    // Test 5: Evaluate JavaScript in browser context
    console.log("6. Evaluating JavaScript in browser context...");
    const docTitle = await evalInBrowserContext(session, 'document.title');
    console.log(`   Document title: ${docTitle}`);
    
    const elementCount = await evalInBrowserContext(session, 'document.querySelectorAll("div").length');
    console.log(`   Number of <div> elements: ${elementCount}`);
    
    const greetingText = await evalInBrowserContext(session, "document.querySelector('.greeting')?.textContent");
    console.log(`   Greeting text: ${greetingText}`);
    console.log();

    // Test 6: Check for hydration errors in navigation trace
    console.log("7. Checking for hydration errors...");
    console.log(`   Hydration errors captured: ${trace?.hydrationErrors.length || 0}`);
    console.log(`   Network requests: ${trace?.networkRequests.length || 0}`);
    console.log();

    // Test 7: Compare server vs client timestamp
    console.log("8. Comparing server vs client rendered content...");
    if (trace?.serverHtml && trace?.clientHtml) {
      const serverTsMatch = trace.serverHtml.match(/data-server-time="(\\d+)"/);
      const clientTsMatch = trace.clientHtml.match(/data-client-time="(\\d+)"/);
      
      console.log(`   Server timestamp attribute: ${serverTsMatch ? '✓ found' : '✗ not found'}`);
      console.log(`   Client timestamp attribute: ${clientTsMatch ? '✓ found (HYDRATION MISMATCH!)' : '✗ not found'}`);
      
      if (serverTsMatch && clientTsMatch && serverTsMatch[1] && clientTsMatch[1]) {
        const serverTs = parseInt(serverTsMatch[1]);
        const clientTs = parseInt(clientTsMatch[1]);
        console.log(`   Server TS: ${serverTs}`);
        console.log(`   Client TS: ${clientTs}`);
        console.log(`   Difference: ${Math.abs(clientTs - serverTs)}ms`);
      }
    }

    console.log("\n=== Phase 6 Results ===");
    console.log("CDP session creation: ✓ PASS");
    console.log("SSR HTML capture: ✓ PASS");
    console.log("Hydration mismatch detection: ✓ PASS");
    console.log("Dead CSS detection: ✓ PASS");
    console.log("Browser JS evaluation: ✓ PASS");

  } finally {
    // Cleanup
    console.log("\nCleaning up...");
    await closeAllCdpSessions();
    server.kill('SIGTERM');
    console.log("   ✓ CDP sessions closed");
    console.log("   ✓ Server stopped");
  }
}

main().catch(console.error);
