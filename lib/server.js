#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webp': 'image/webp',
  '.webm': 'video/webm',
};

const SCROLL_SYNC_SCRIPT = `
<script>
(function() {
  if (window.__bpSyncLoaded) return;
  window.__bpSyncLoaded = true;
  var syncing = false;
  window.addEventListener('scroll', function() {
    if (syncing) return;
    var maxY = document.documentElement.scrollHeight - window.innerHeight;
    var ratio = maxY > 0 ? window.scrollY / maxY : 0;
    window.parent.postMessage({ type: 'bp-scroll', ratio: ratio }, '*');
  }, { passive: true });
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'bp-scroll-set') {
      syncing = true;
      var maxY = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, e.data.ratio * maxY);
      requestAnimationFrame(function() { syncing = false; });
    }
  });
})();
</script>
`;

const rootDir = path.resolve(process.argv[2] || '.');
const startPort = parseInt(process.argv[3], 10) || 8787;
const proxyTarget = process.argv[4] || null;

if (!fs.existsSync(rootDir)) {
  console.error(`Error: Directory does not exist: ${rootDir}`);
  process.exit(1);
}

function serve(port) {
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${port}`);

    // Serve preview HTML from disk
    if (parsedUrl.pathname === '/_preview.html') {
      const filePath = path.join(rootDir, '_preview.html');
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }

    // Proxy to target dev server
    if (proxyTarget) {
      const targetUrl = new URL(req.url, proxyTarget);
      const headers = { ...req.headers, host: targetUrl.host, 'accept-encoding': 'identity' };
      const proxyReq = http.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const respHeaders = { ...proxyRes.headers };
        delete respHeaders['x-frame-options'];
        delete respHeaders['content-security-policy'];

        if (contentType.includes('text/html')) {
          const body = [];
          proxyRes.on('data', chunk => body.push(chunk));
          proxyRes.on('end', () => {
            let html = Buffer.concat(body).toString();
            if (html.includes('</head>')) {
              html = html.replace('</head>', `${SCROLL_SYNC_SCRIPT}</head>`);
            } else {
              html += SCROLL_SYNC_SCRIPT;
            }
            delete respHeaders['content-length'];
            res.writeHead(proxyRes.statusCode, respHeaders);
            res.end(html);
          });
        } else {
          res.writeHead(proxyRes.statusCode, respHeaders);
          proxyRes.pipe(res);
        }
      });
      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Proxy error: ${err.message}`);
      });
      req.pipe(proxyReq);
      return;
    }

    // Static file serving
    let filePath = path.resolve(rootDir, decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, ''));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const canonicalRoot = path.resolve(rootDir) + path.sep;
    const canonicalFile = path.resolve(filePath);
    if (!canonicalFile.startsWith(canonicalRoot) && canonicalFile !== path.resolve(rootDir)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(`404 Not Found: ${req.url}`); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });

  // WebSocket proxy for HMR (Vite, Webpack, etc.)
  if (proxyTarget) {
    server.on('upgrade', (req, socket, head) => {
      const targetUrl = new URL(proxyTarget);
      const net = require('net');
      const proxy = net.connect(targetUrl.port || 80, targetUrl.hostname || 'localhost', () => {
        const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        const hdrs = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        proxy.write(reqLine + hdrs + '\r\n\r\n');
        if (head.length) proxy.write(head);
        socket.pipe(proxy).pipe(socket);
      });
      proxy.on('error', () => socket.end());
      socket.on('error', () => proxy.end());
    });
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') serve(port + 1);
    else { console.error(`Server error: ${err.message}`); process.exit(1); }
  });

  server.listen(port, () => {
    console.log(`SERVING_PORT:${port}`);
  });
}

serve(startPort);
