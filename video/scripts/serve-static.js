import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './common.js';

const dir = path.resolve(ROOT, process.argv[2] || 'stub');
const port = Number(process.argv[3] || 4177);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const safe = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(dir, safe);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(dir) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`stub server http://127.0.0.1:${port}/ -> ${dir}`));
