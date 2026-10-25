import { spawn, spawnSync } from 'node:child_process';
import { parseArgs, ROOT } from './common.js';

function run(args) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HF_HOME: `${ROOT}/.cache/hf`, TRANSFORMERS_CACHE: `${ROOT}/.cache/hf` } });
  if (res.status !== 0) process.exit(res.status || 1);
}

async function waitFor(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server did not respond at ${url}`);
}

const args = parseArgs();
const scene = args.scene || 'scenes/example.json';
const dryRun = !!args['dry-run'];
const bandArgs = args['subtitle-band-height'] ? ['--subtitle-band-height', String(args['subtitle-band-height'])] : [];
let url = args.url;
let server;
try {
  if (!url) {
    url = 'http://127.0.0.1:4177/';
    server = spawn(process.execPath, ['scripts/serve-static.js', 'stub', '4177'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    await waitFor(url);
  }
  if (dryRun) {
    run(['scripts/record.js', '--dry-run', '--scene', scene, '--url', url, ...bandArgs]);
  } else {
    run(['scripts/tts.js', '--scene', scene]);
    run(['scripts/record.js', '--scene', scene, '--url', url, ...bandArgs]);
    run(['scripts/compose.js', '--scene', scene, ...bandArgs]);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (server?.pid) server.kill('SIGTERM');
}
