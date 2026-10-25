import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// Only our web app, the browser-safe domain code and the locally installed Bryntum Gantt package are served.
const ALLOWED_PREFIXES = ['/web/', '/src/domain/', '/node_modules/@bryntum/gantt/'];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const tsCache = new Map<string, { mtime: number; body: string }>();

export async function serveStatic(pathname: string, res: ServerResponse, _req?: IncomingMessage) {
  let path = decodeURIComponent(pathname);
  if (path === '/') path = '/web/index.html';
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) { res.writeHead(404).end('not found'); return; }
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) { res.writeHead(404).end(); return; }
    const ext = extname(file);
    let body: Buffer | string;
    if (ext === '.ts') {
      // Our TypeScript is served to the browser with types erased (Node's built-in stripper; no bundler).
      const hit = tsCache.get(file);
      if (hit && hit.mtime === st.mtimeMs) body = hit.body;
      else { body = stripTypeScriptTypes(await readFile(file, 'utf8')); tsCache.set(file, { mtime: st.mtimeMs, body }); }
    } else body = await readFile(file);
    const cache = path.startsWith('/node_modules/') ? 'public, max-age=3600' : 'no-store';
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}
