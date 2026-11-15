// SHOWHAUS — community input with no login (dist/showhaus/walk):
//   POST /api/suggest/home { url, anon }        "walk this home next": a link to a floor plan that is already published
//                                               (a builder's or agent's page). Links only — no file is accepted, stored or
//                                               rendered, and no submitted link is shown to other visitors. The same link from
//                                               different visitors adds up as votes; the build queue reads the totals.
//   POST /api/suggest/fix  { p, room, note, anon }   "something is wrong here" on an existing walk: a room and one line.
//   GET  /api/suggest/count                     { homes } — how many distinct homes have been suggested (a number only).
// Read side (GitHub-OIDC only): /api/ops/summary → suggestions { homes (by votes), fixes (newest) }.
import { db, pseudo } from './ops/store.js';
import { track, environmentOf } from './ops/events.js';
import { hit, isPrivate } from './claim.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sh_claim_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`, // shared with src/claim.js (hit)
  `CREATE TABLE IF NOT EXISTS sh_suggest (k TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, at TEXT NOT NULL, env TEXT NOT NULL, votes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new')`,
  `CREATE TABLE IF NOT EXISTS sh_suggest_votes (k TEXT NOT NULL, voter TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (k, voter))`,
  `CREATE TABLE IF NOT EXISTS sh_fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, room TEXT, note TEXT NOT NULL, at TEXT NOT NULL, env TEXT NOT NULL, actor TEXT, status TEXT NOT NULL DEFAULT 'new')`,
];
let ready = null;
async function sdb(env) {
  const d = await db(env);
  if (!d) return null;
  if (!ready) ready = d.batch(SCHEMA.map(s => d.prepare(s))).catch(e => { ready = null; throw e; });
  await ready;
  return d;
}
export function resetSuggestForTests() { ready = null; }

const j = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const PER_HOUR = 10;
const OWN = /(^|\.)showhaus\.app$/;
const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|src$)/i;

// One home = one key: https only, a real public host, no tracking parameters, no fragment, no trailing slash.
export function normalizePlanUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s || s.length > 400) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.username || u.password || u.port) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host) || OWN.test(host)) return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, '') || '';
  const q = u.searchParams.toString();
  const url = `https://${host}${path}${q ? '?' + q : ''}`;
  return url.length > 300 ? null : { url, host };
}

async function who(request, d, anon) {
  const ip = await pseudo(d, 'ip', request.headers.get('cf-connecting-ip') || 'local');
  const a = /^[\w-]{8,64}$/.test(String(anon || '')) ? 'a:' + await pseudo(d, 'anon', String(anon)) : null;
  return { ip, actor: a, voter: a || 'ip:' + ip };
}

export async function handleSuggest(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/suggest/')) return null;
  try {
    const d = await sdb(env);
    if (!d) return j({ error: 'Not available here yet.' }, 503);
    if (path === '/api/suggest/count' && request.method === 'GET') {
      const n = (await d.prepare("SELECT COUNT(*) AS n FROM sh_suggest WHERE env = 'production'").first())?.n || 0;
      return new Response(JSON.stringify({ homes: n }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } });
    }
    if (request.method !== 'POST') return j({ error: 'method' }, 405);
    const o = request.headers.get('origin');
    if (o) { try { if (new URL(o).host !== url.host) return new Response('forbidden', { status: 403 }); } catch { return new Response('forbidden', { status: 403 }); } }
    const body = await request.json().catch(() => ({}));
    const environment = environmentOf(request, { claimed: body.env === 'synthetic' ? 'synthetic' : undefined });
    const { ip, actor, voter } = await who(request, d, body.anon);
    if (!(await hit(d, 'sg:' + ip, PER_HOUR, 3600e3))) return j({ error: 'That is a lot at once. Try again in an hour.' }, 429);
    const now = new Date().toISOString();
    const done = p => { if (ctx && ctx.waitUntil) ctx.waitUntil(p); return p; };

    if (path === '/api/suggest/home') {
      const n = normalizePlanUrl(body.url);
      if (!n) return j({ error: 'Paste the link to the page that shows the floor plan.' }, 400);
      await d.prepare('INSERT INTO sh_suggest (k, url, host, at, env) VALUES (?, ?, ?, ?, ?) ON CONFLICT(k) DO NOTHING').bind(n.url, n.url, n.host, now, environment).run();
      const added = await d.prepare('INSERT OR IGNORE INTO sh_suggest_votes (k, voter, at) VALUES (?, ?, ?)').bind(n.url, voter, now).run();
      const fresh = !!(added.meta && added.meta.changes);
      if (fresh) await d.prepare('UPDATE sh_suggest SET votes = votes + 1 WHERE k = ?').bind(n.url).run();
      const votes = (await d.prepare('SELECT votes FROM sh_suggest WHERE k = ?').bind(n.url).first())?.votes || 1;
      if (fresh) await done(track(env, { name: 'home_suggested', env: environment, source: 'server', actor, path, props: { kind: 'walk:gallery', step: votes === 1 ? 'new' : 'vote', ref: n.host } }).catch(() => {}));
      return j({ ok: true, votes, counted: fresh, host: n.host });
    }
    if (path === '/api/suggest/fix') {
      const slug = String(body.p || '');
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return j({ error: 'Unknown home.' }, 404);
      const r = await env.ASSETS.fetch(new Request(`${url.origin}/showhaus/walk/data/${slug}.json`)).catch(() => null);
      if (!r || !r.ok || await isPrivate(env, slug)) return j({ error: 'Unknown home.' }, 404);
      const note = clean(body.note, 280), room = clean(body.room, 40) || null;
      if (note.length < 4) return j({ error: 'Say what is wrong in a few words.' }, 400);
      await d.prepare('INSERT INTO sh_fixes (slug, room, note, at, env, actor) VALUES (?, ?, ?, ?, ?, ?)').bind(slug, room, note, now, environment, actor).run();
      await done(track(env, { name: 'fix_reported', env: environment, source: 'server', actor, path, props: { kind: 'walk:' + slug, step: room || undefined } }).catch(() => {}));
      return j({ ok: true });
    }
    return j({ error: 'not found' }, 404);
  } catch (e) {
    console.error('suggest', path, e && e.stack || e);
    return j({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

export async function suggestSummary(env) {
  const d = await sdb(env);
  if (!d) return null;
  const homes = (await d.prepare("SELECT url, host, votes, at, status FROM sh_suggest WHERE env = 'production' ORDER BY votes DESC, at LIMIT 50").all()).results;
  const fixes = (await d.prepare("SELECT id, slug, room, note, at, status FROM sh_fixes WHERE env = 'production' ORDER BY at DESC LIMIT 50").all()).results;
  return { homes, fixes };
}
