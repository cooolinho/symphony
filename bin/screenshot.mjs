#!/usr/bin/env node
// symphony-screenshot: one PNG of a page with headless Chromium, optionally after a form login.
// For more steps than this covers, write a Playwright script: `import { chromium } from 'playwright'` works anywhere.
import { parseArgs } from 'node:util';

const usage = `Usage: symphony-screenshot <url> <out.png> [options]
       symphony-screenshot --check

  --check               Start Chromium once and report whether it works (no URL, no file)
  --viewport WxH        Viewport size (default 1280x800)
  --scale N             Device scale factor (default 1; 2 for sharp crops)
  --login-url URL       Log in first: fill the email and password fields there and submit
  --email EMAIL         Login email
  --password PASSWORD   Login password (or SCREENSHOT_PASSWORD in the environment)
  --header 'K: V'       Extra request header, repeatable (e.g. 'Host: app.example.test')
  --click SELECTOR      Click before the screenshot, repeatable, in order
  --wait-for SELECTOR   Wait until the selector is visible before the screenshot
  --clip X,Y,W,H        Capture only this rectangle (CSS pixels)
  --full-page           Capture the whole scrollable page
  --timeout MS          Timeout per step (default 30000)`;

function fail(message) {
  console.error(`symphony-screenshot: ${message}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      viewport: { type: 'string', default: '1280x800' },
      scale: { type: 'string', default: '1' },
      'login-url': { type: 'string' },
      email: { type: 'string' },
      password: { type: 'string' },
      header: { type: 'string', multiple: true, default: [] },
      click: { type: 'string', multiple: true, default: [] },
      'wait-for': { type: 'string' },
      clip: { type: 'string' },
      'full-page': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '30000' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (error) {
  fail(`${error.message}\n\n${usage}`);
}
const { values: opts, positionals } = parsed;
if (opts.help) {
  console.log(usage);
  process.exit(0);
}
if (!opts.check && positionals.length !== 2) fail(`expected <url> and <out.png>\n\n${usage}`);
const [url, out] = positionals;

const viewport = /^(\d+)x(\d+)$/.exec(opts.viewport);
if (viewport === null) fail(`--viewport must look like 1280x800, got "${opts.viewport}"`);
const headers = Object.fromEntries(
  opts.header.map((line) => {
    const at = line.indexOf(':');
    if (at < 1) fail(`--header must look like 'Name: value', got "${line}"`);
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }),
);
let clip;
if (opts.clip !== undefined) {
  const parts = opts.clip.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) fail(`--clip must look like 0,0,720,230, got "${opts.clip}"`);
  clip = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}
const password = opts.password ?? process.env.SCREENSHOT_PASSWORD;
if (opts['login-url'] !== undefined && (opts.email === undefined || password === undefined)) {
  fail('--login-url needs --email and --password (or SCREENSHOT_PASSWORD)');
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  fail('Playwright is not installed in this image (built with WITH_BROWSER=false?)');
}

if (opts.check) {
  try {
    const browser = await chromium.launch();
    await (await browser.newPage()).setContent('<p>ok</p>');
    console.log(`chromium ${browser.version()} ok (${process.env.PLAYWRIGHT_BROWSERS_PATH ?? 'default browsers path'})`);
    await browser.close();
    process.exit(0);
  } catch (error) {
    fail(`Chromium does not start: ${error.message}`);
  }
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: Number(viewport[1]), height: Number(viewport[2]) },
    deviceScaleFactor: Number(opts.scale),
    extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(opts.timeout));

  if (opts['login-url'] !== undefined) {
    await page.goto(opts['login-url'], { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', opts.email);
    await page.fill('input[type="password"]', password);
    const loginPath = new URL(page.url()).pathname;
    await page.click('button[type="submit"]');
    await page.waitForURL((current) => current.pathname !== loginPath);
  }

  const response = await page.goto(url, { waitUntil: 'networkidle' });
  if (response !== null && response.status() >= 400) console.error(`symphony-screenshot: warning: ${url} answered ${response.status()}`);
  for (const selector of opts.click) {
    await page.click(selector);
    await page.waitForLoadState('networkidle');
  }
  if (opts['wait-for'] !== undefined) await page.waitForSelector(opts['wait-for'], { state: 'visible' });

  await page.screenshot({ path: out, fullPage: opts['full-page'], clip });
  console.log(`${out} (${page.url()})`);
} finally {
  await browser.close();
}
