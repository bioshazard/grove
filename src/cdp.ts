import puppeteer, { Browser, Page, CDPSession } from 'puppeteer';

export interface CdpSessionOptions {
  headless?: boolean;
  timeout?: number;
  captureCssMatches?: boolean;
}

export interface CdpSession {
  browser: Browser;
  page: Page;
  client: CDPSession;
  options: CdpSessionOptions;
  navigationTraces: NavigationTrace[];
  consoleMessages: ConsoleMessage[];
  jsExceptions: JsException[];
  cssMatches: CssMatch[];
  _closed: boolean;
}

export interface NavigationTrace {
  url: string;
  timestamp: number;
  serverHtml?: string;
  clientHtml?: string;
  hydrationErrors: HydrationError[];
  networkRequests: NetworkRequest[];
  paintTimeMs?: number;
}

export interface HydrationError {
  type: 'mismatch' | 'exception';
  message: string;
  nodeDescription?: string;
  serverValue?: unknown;
  clientValue?: unknown;
  stack?: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  startTime: number;
  endTime: number;
  durationMs: number;
}

export interface ConsoleMessage {
  type: 'log' | 'error' | 'warn' | 'info';
  text: string;
  timestamp: number;
  stack?: string;
}

export interface JsException {
  message: string;
  stack: string;
  timestamp: number;
}

export interface CssMatch {
  selector: string;
  matchCount: number;
  matchedElements: string[];
}

export interface SsrDiffResult {
  mismatch: boolean;
  serverOutput: string;
  clientOutput: string;
  differences?: Array<{
    type: 'text' | 'attribute' | 'node';
    path: string;
    serverValue: string;
    clientValue: string;
  }>;
}

let cachedBrowser: Browser | null = null;
let isBrowserClosed = false;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function createCdpSession(
  url: string,
  options: CdpSessionOptions = {}
): Promise<CdpSession> {
  const headless = options.headless ?? true;
  const timeout = options.timeout ?? 30000;

  let browser: Browser;
  if (cachedBrowser && !isBrowserClosed) {
    browser = cachedBrowser;
  } else {
    browser = await puppeteer.launch({
      headless: headless ? true : false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    cachedBrowser = browser;
  }

  const page = await browser.newPage();
  
  (page as any)._timeout = timeout;

  const client = await page.target().createCDPSession();

  await Promise.all([
    client.send('Page.enable'),
    client.send('Network.enable'),
    client.send('Console.enable'),
    client.send('Runtime.enable'),
  ]);

  const session: CdpSession = {
    browser,
    page,
    client,
    options: { headless, timeout, ...options },
    navigationTraces: [],
    consoleMessages: [],
    jsExceptions: [],
    cssMatches: [],
    _closed: false,
  };

  page.on('console', (msg: any) => {
    session.consoleMessages.push({
      type: msg.type() as any,
      text: msg.text(),
      timestamp: Date.now(),
    });
  });

  page.on('pageerror', (error: any) => {
    session.jsExceptions.push({
      message: error.message || String(error),
      stack: error.stack || '',
      timestamp: Date.now(),
    });
  });

  await page.goto(url, { waitUntil: 'networkidle0', timeout });

  const trace: NavigationTrace = {
    url,
    timestamp: Date.now(),
    hydrationErrors: [],
    networkRequests: [],
  };

  // Server HTML (capture immediately after navigation)
  trace.serverHtml = await page.content();

  // Wait longer for client-side hydration to occur
  await sleep(500);

  // Client HTML after hydration
  trace.clientHtml = await page.content();

  session.navigationTraces.push(trace);

  return session;
}

export async function captureSsrHtml(
  session: CdpSession,
  url: string
): Promise<string> {
  await (session.page.evaluate as any)(`(() => {
    const doc = document;
    const scriptTags = doc.querySelectorAll('script');
    scriptTags.forEach(script => {
      const noscript = doc.createElement('noscript');
      noscript.appendChild(script.cloneNode(true));
      script.replaceWith(noscript);
    });
  })()`);

  await session.page.goto(url, { waitUntil: 'domcontentloaded' });
  const ssrHtml = await session.page.content();

  await session.page.goto(url, { waitUntil: 'networkidle0' });

  return ssrHtml;
}

export async function diffSsrOutputs(
  _session: CdpSession,
  serverHtml: string,
  clientHtml: string
): Promise<SsrDiffResult> {
  const mismatch = serverHtml !== clientHtml;
  
  if (!mismatch) {
    return {
      mismatch: false,
      serverOutput: serverHtml,
      clientOutput: clientHtml,
    };
  }

  let firstDiffIndex = -1;
  for (let i = 0; i < Math.min(serverHtml.length, clientHtml.length); i++) {
    if (serverHtml[i] !== clientHtml[i]) {
      firstDiffIndex = i;
      break;
    }
  }

  const contextLen = 50;
  const start = Math.max(0, firstDiffIndex - contextLen);
  const end = Math.min(Math.max(serverHtml.length, clientHtml.length), firstDiffIndex + contextLen);

  const differences: SsrDiffResult['differences'] = [{
    type: 'text',
    path: `character ${firstDiffIndex}`,
    serverValue: serverHtml.slice(start, end).replace(/\n/g, '\\n'),
    clientValue: clientHtml.slice(start, end).replace(/\n/g, '\\n'),
  }];

  return {
    mismatch: true,
    serverOutput: serverHtml,
    clientOutput: clientHtml,
    differences,
  };
}

export async function captureCssMatches(
  session: CdpSession
): Promise<CssMatch[]> {
  const result: CssMatch[] = await (session.page.evaluate as any)(`(() => {
    const doc = document;
    const stylesheets = Array.from(doc.styleSheets);
    const selectorMatches = [];

    for (const sheet of stylesheets) {
      try {
        const rules = Array.from(sheet.cssRules || []);
        for (const rule of rules) {
          if (rule.selectorText) {
            const selector = rule.selectorText;
            const elements = Array.from(doc.querySelectorAll(selector));
            selectorMatches.push({
              selector,
              matchCount: elements.length,
              matchedElements: elements.slice(0, 5).map(el => el.tagName?.toLowerCase() || '#text'),
            });
          }
        }
      } catch (e) {
        // Cross-origin stylesheets will throw
      }
    }

    return selectorMatches;
  })()`);

  return result;
}

export async function evalInBrowserContext(
  session: CdpSession,
  expression: string
): Promise<unknown> {
  return await session.page.evaluate(expression);
}

export async function findHydrationMismatch(
  session: CdpSession,
  componentSelector: string
): Promise<{ found: boolean; serverContent?: string; clientContent?: string } | undefined> {
  const serverContent = await session.page.$eval(
    componentSelector,
    (el: any) => el.innerHTML
  );

  await (session.page.evaluate as any)(`selector => {
    const el = document.querySelector(selector);
    if (el) {
      el.dispatchEvent(new Event('hydration-complete', { bubbles: true }));
    }
  }`, componentSelector);

  await sleep(50);

  const clientContent = await session.page.$eval(
    componentSelector,
    (el: any) => el.innerHTML
  );

  if (serverContent !== clientContent) {
    return {
      found: true,
      serverContent,
      clientContent,
    };
  }

  return { found: false };
}

export async function closeCdpSession(session: CdpSession): Promise<void> {
  session._closed = true;
  await session.page.close();
}

export async function closeAllCdpSessions(): Promise<void> {
  if (cachedBrowser && !isBrowserClosed) {
    await cachedBrowser.close();
    cachedBrowser = null;
    isBrowserClosed = true;
  }
}
