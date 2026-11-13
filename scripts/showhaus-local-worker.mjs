// Serve the real Worker (src/worker.js) on localhost with dist/ as the asset binding and an in-memory D1 (node:sqlite).
// For click-through judges when wrangler is not available:  node scripts/showhaus-local-worker.mjs [port]
// Answers like a workers.dev host: SHOWHAUS lives under /showhaus/. Nothing is persisted and no mail is sent.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.run())), _db: db };
}
const ASSETS = {
  async fetch(req) {
    let p = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^([/\\])+/, '');
    if (p.includes('..')) return new Response('bad path', { status: 400 });
    let file = join(DIST, p);
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { return new Response('not found', { status: 404 }); }
    try { return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } }); }
    catch { return new Response('not found', { status: 404 }); }
  },
};
export const env = { OPS_DB: d1(), ASSETS, POSTHOG_MIRROR: 'off' };

export function serve(port = 8787) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
    const pending = [];
    try {
      const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body, redirect: 'manual' }), env, { waitUntil: p => pending.push(p) });
      const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(r.status, headers); res.end(Buffer.from(await r.arrayBuffer()));
      await Promise.allSettled(pending);
    } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok(server)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const port = Number(process.argv[2]) || 8787; await serve(port); console.log(`SHOWHAUS worker on http://127.0.0.1:${port}/showhaus/`); }
