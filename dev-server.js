/**
 * CINEVERSE Local Development & CORS Bypass Proxy Server
 * Uses ZERO npm dependencies (built-in Node.js 'http', 'https', 'fs', 'path')
 * 
 * Usage:
 *   node dev-server.js
 *   Open http://localhost:3000 in your browser
 * 
 * This serves static frontend files and proxies any /aws-proxy/* requests
 * directly to the live AWS API Gateway in Mumbai, adding standard CORS headers
 * so you can test all features locally without browser CORS restrictions.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const AWS_HOST = 'jtajs6rkjk.execute-api.ap-south-1.amazonaws.com';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // Handle CORS preflight for all endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Check if request is for the AWS proxy
  if (req.url.startsWith('/aws-proxy/')) {
    const targetPath = req.url.replace('/aws-proxy', '');

    const options = {
      hostname: AWS_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': req.headers['content-type'] || 'application/json'
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('AWS Proxy Error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Proxy Gateway Error: ' + err.message }));
    });

    req.pipe(proxyReq);
    return;
  }

  // Serve static files
  let safePath = req.url.split('?')[0];
  if (safePath === '/' || safePath === '') {
    safePath = '/index.html';
  }

  const filePath = path.join(__dirname, safePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found: ' + safePath);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error: ' + err.message);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🎬 CINEVERSE Local Dev Server Active`);
  console.log(`======================================================`);
  console.log(`• Local App URL:  http://localhost:${PORT}`);
  console.log(`• AWS Target:     https://${AWS_HOST}`);
  console.log(`• Local Proxy:    http://localhost:${PORT}/aws-proxy/*`);
  console.log(`\nReady for browser testing with full CORS support!`);
  console.log(`Press Ctrl+C to stop.\n`);
});
