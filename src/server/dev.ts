import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ALLOWED_PREFIXES = ['/web/', '/src/domain/', '/node_modules/@bryntum/gantt/'];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png',
};

export function startDevServer(port = Number(process.env.PORT || 4317), host = '127.0.0.1') {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}`);
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/web/index.html';
      if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) { res.writeHead(404).end('not found'); return; }
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
      const ext = extname(file);
      let body: Buffer | string = await readFile(file);
      // Serve our TypeScript to the browser with types erased (no bundler needed).
      if (ext === '.ts') body = stripTypeScriptTypes(body.toString('utf8'));
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise<typeof server>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startDevServer();
  const addr = server.address();
  console.log(`Tranche spike on http://${typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : addr}/ (pid ${process.pid})`);
}
