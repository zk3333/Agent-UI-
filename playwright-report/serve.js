const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
http.createServer((req, res) => {
  let f = req.url === '/' ? 'index.html' : req.url;
  const fp = path.join(root, f);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(f);
    const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.webm':'video/webm', '.ttf':'font/ttf', '.webmanifest':'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(8766, () => console.log('Report server: http://localhost:8766'));
