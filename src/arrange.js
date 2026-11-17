// SHOWHAUS arrange (dist/showhaus/arrange): a furniture layout on a floor plan, shared without sign-up. Same pattern as the
// hunt board: the maker gets { id, edit }; the page keeps the edit token in its own address (#e=) and in the browser.
//   POST /api/arrange/board { layout }               → { id, edit }. Re-post with { id, edit, layout } to update.
//   GET  /api/arrange/board?id=                      → { layout, updated } for anyone with the link.
// The layout is cleaned with the same function the page uses (plan-core.js cleanLayout): plan slug or a measured room,
// at most 80 pieces, numbers bounded, labels plain text.
import { db, pseudo } from './ops/store.js';
import { track, environmentOf } from './ops/events.js';
import { hit } from './claim.js';
import { cleanLayout } from '../dist/showhaus/walk/plan-core.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sh_claim_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sh_arrange (id TEXT PRIMARY KEY, edit TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, env TEXT NOT NULL)`,
];
let ready = null;
async function adb(env) {
  const d = await db(env);
  if (!d) return null;
  if (!ready) ready = d.batch(SCHEMA.map(s => d.prepare(s))).catch(e => { ready = null; throw e; });
  await ready;
  return d;
}
export function resetArrangeForTests() { ready = null; }
export const SHARES_PER_HOUR = 30, UPDATES_PER_HOUR = 600, MAX_BYTES = 16000;

const j = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
function token(n) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, x => a[x % a.length]).join('');
}

export async function handleArrange(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/api/arrange/board') return null;
  try {
    const d = await adb(env);
    if (!d) return j({ error: 'Sharing is not available here yet. Your layout is saved on this phone.' }, 503);
    if (request.method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[a-z0-9]{10}$/.test(id)) return j({ error: 'Unknown layout.' }, 404);
      const row = await d.prepare('SELECT data, updated FROM sh_arrange WHERE id = ?').bind(id).first();
      if (!row) return j({ error: 'Unknown layout.' }, 404);
      return j({ layout: JSON.parse(row.data), updated: row.updated });
    }
    if (request.method !== 'POST') return j({ error: 'method' }, 405);
    const body = await request.json().catch(() => ({}));
    const layout = cleanLayout(body.layout);
    if (!layout) return j({ error: 'Pick a floor plan or type a room size first.' }, 400);
    const data = JSON.stringify(layout);
    if (data.length > MAX_BYTES) return j({ error: 'This layout is too big to share.' }, 413);
    const ip = await pseudo(d, 'ip', request.headers.get('cf-connecting-ip') || 'local'), now = new Date().toISOString();
    if (body.id) {
      const id = String(body.id);
      const row = /^[a-z0-9]{10}$/.test(id) ? await d.prepare('SELECT edit FROM sh_arrange WHERE id = ?').bind(id).first() : null;
      if (!row || row.edit !== await pseudo(d, 'arrange', String(body.edit || ''))) return j({ error: 'Only the person who shared this layout can change it.' }, 403);
      if (!(await hit(d, 'au:' + ip, UPDATES_PER_HOUR, 3600e3))) return j({ error: 'Too many changes this hour. Your layout is still on this phone.' }, 429);
      await d.prepare('UPDATE sh_arrange SET data = ?, updated = ? WHERE id = ?').bind(data, now, id).run();
      return j({ id, ok: true });
    }
    if (!(await hit(d, 'as:' + ip, SHARES_PER_HOUR, 3600e3))) return j({ error: 'Too many shared layouts this hour.' }, 429);
    const id = token(10), edit = token(24), environment = environmentOf(request);
    await d.prepare('INSERT INTO sh_arrange (id, edit, data, created, updated, env) VALUES (?, ?, ?, ?, ?, ?)').bind(id, await pseudo(d, 'arrange', edit), data, now, now, environment).run();
    ctx && ctx.waitUntil && ctx.waitUntil(track(env, { name: 'arrange_share', env: environment, source: 'server', path, props: { kind: layout.plan ? 'plan:' + layout.plan : 'room', cta: String(layout.items.length) } }).catch(() => {}));
    return j({ id, edit });
  } catch (e) {
    console.error('arrange', e && e.message);
    return j({ error: 'Something went wrong. Your layout is still on this phone.' }, 500);
  }
}
