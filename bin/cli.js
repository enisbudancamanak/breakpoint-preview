#!/usr/bin/env node

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const LIB_DIR = path.join(__dirname, '..', 'lib');
const PREVIEW_HTML = path.join(LIB_DIR, 'preview.html');
const SERVER_SCRIPT = path.join(LIB_DIR, 'server.js');

function parseArgs(args) {
  let target = null;
  let breakpoints = null;
  let appMode = false;
  let port = 8787;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--breakpoints' && args[i + 1]) {
      breakpoints = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--app') {
      appMode = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else if (!target) {
      target = args[i];
    }
  }

  return { target, breakpoints, appMode, port };
}

function printHelp() {
  console.log(`
  breakpoint-preview — See all breakpoints at once

  Usage:
    breakpoint-preview <url>                          Preview a dev server
    breakpoint-preview <path>                         Preview a static file
    breakpoint-preview <url> --breakpoints 320,768    Custom breakpoints
    breakpoint-preview <url> --app                    Open in standalone window
    breakpoint-preview <url> --port 9000              Custom port

  Examples:
    breakpoint-preview http://localhost:3000
    breakpoint-preview http://localhost:5173 --app
    breakpoint-preview ./index.html --breakpoints 375,768,1024,1440,1920

  Features:
    - Per-viewport URL bar (type a path, hit Enter)
    - Hide/show viewports (click Hide, click collapsed to restore)
    - Scroll sync toggle (settings popover, top-right dot)
    - State persists across reloads (URLs, hidden viewports)
    - HMR pass-through (Vite, Webpack, etc.)
    - Zero dependencies
  `);
}

function isUrl(str) {
  return /^https?:\/\//i.test(str);
}

function findBrowser() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
    ? ['chrome', 'msedge']
    : ['chromium', 'google-chrome-stable', 'google-chrome', 'chromium-browser'];

  for (const cmd of candidates) {
    try {
      require('child_process').execFileSync('which', [cmd], { stdio: 'ignore' });
      return cmd;
    } catch {}
  }
  return null;
}

function openUrl(url, appMode) {
  if (appMode) {
    const browser = findBrowser();
    if (browser) {
      spawn(browser, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    console.log('No Chrome/Chromium found for --app mode, falling back to default browser.');
  }

  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  execFile(cmd, [url], (err) => {
    if (err) console.error(`Could not open browser: ${err.message}`);
  });
}

function buildPreviewUrl(port, targetUrl, breakpoints) {
  const params = new URLSearchParams();
  params.set('url', targetUrl);
  if (breakpoints) params.set('breakpoints', breakpoints);
  return `http://localhost:${port}/_preview.html?${params.toString()}`;
}

function startServer(serveDir, proxyUrl, startPort, onReady) {
  const previewDest = path.join(serveDir, '_preview.html');
  fs.copyFileSync(PREVIEW_HTML, previewDest);

  const args = [SERVER_SCRIPT, serveDir, String(startPort)];
  if (proxyUrl) args.push(proxyUrl);
  const server = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  let ready = false;

  const timeout = setTimeout(() => {
    if (!ready) {
      console.error('Server failed to start within 10 seconds.');
      server.kill();
      try { fs.unlinkSync(previewDest); } catch {}
      process.exit(1);
    }
  }, 10000);

  server.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    if (!ready) {
      const match = output.match(/SERVING_PORT:(\d+)/);
      if (match) {
        ready = true;
        clearTimeout(timeout);
        onReady(parseInt(match[1], 10));
      }
    }
  });

  server.stderr.on('data', (data) => process.stderr.write(data));

  server.on('close', (code) => {
    clearTimeout(timeout);
    try { fs.unlinkSync(previewDest); } catch {}
  });

  function cleanup() {
    server.kill();
    try { fs.unlinkSync(previewDest); } catch {}
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return server;
}

// Main
const { target, breakpoints, appMode, port } = parseArgs(process.argv.slice(2));

if (!target) {
  printHelp();
  process.exit(0);
}

if (isUrl(target)) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-preview-'));
  process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });

  console.log(`\n  Breakpoint Preview → ${target}\n`);

  startServer(tmpDir, target, port, (actualPort) => {
    const localUrl = `http://localhost:${actualPort}/`;
    const previewUrl = buildPreviewUrl(actualPort, localUrl, breakpoints);
    console.log(`  Preview: ${previewUrl}`);
    console.log(`  Press Ctrl+C to stop\n`);
    openUrl(previewUrl, appMode);
  });
} else {
  const resolvedPath = path.resolve(target);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Path does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(resolvedPath);
  const serveDir = stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const fileName = stat.isDirectory() ? 'index.html' : path.basename(resolvedPath);

  console.log(`\n  Breakpoint Preview → ${resolvedPath}\n`);

  startServer(serveDir, null, port, (actualPort) => {
    const targetUrl = `http://localhost:${actualPort}/${fileName}`;
    const previewUrl = buildPreviewUrl(actualPort, targetUrl, breakpoints);
    console.log(`  Preview: ${previewUrl}`);
    console.log(`  Press Ctrl+C to stop\n`);
    openUrl(previewUrl, appMode);
  });
}
