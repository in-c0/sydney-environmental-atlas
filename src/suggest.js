// SHOWHAUS — community input with no login (dist/showhaus/walk):
//   POST /api/suggest/home { url, anon }        "walk this home next": a link to a floor plan that is already published
//                                               (a builder's or agent's page). Links only — no file is accepted, stored or
//                                               rendered, and no submitted link is shown to other visitors. The same link from
//                                               different visitors adds up as votes; the build queue reads the totals.
//   POST /api/suggest/fix  { p, room, note, anon }   "something is wrong here" on an existing walk: a room and one line.
//                                               Optional `email`: "tell me when it is ready" — kept only until that one
//                                               email is sent (POST /api/ops/suggest-built, OIDC), then deleted.
//   GET  /api/suggest/count                     { homes } — how many distinct homes have been suggested (a number only).
// Read side (GitHub-OIDC only): /api/ops/summary → suggestions { homes (by votes), fixes (newest) }.
import { db, pseudo } from './ops/store.js';
import { track, environmentOf } from './ops/events.js';
import { hit, isPrivate, claimSummary } from './claim.js';
import { sendMail, mailMode } from './ops/auth.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sh_claim_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`, // shared with src/claim.js (hit)
  `CREATE TABLE IF NOT EXISTS sh_suggest (k TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, at TEXT NOT NULL, env TEXT NOT NULL, votes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new')`,
  `CREATE TABLE IF NOT EXISTS sh_suggest_votes (k TEXT NOT NULL, voter TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (k, voter))`,
  `CREATE TABLE IF NOT EXISTS sh_suggest_notify (k TEXT NOT NULL, email TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (k, email))`, // deleted once the email is sent
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
      let notify = false;
      const email = String(body.email || '').trim().toLowerCase();
      if (email) {
        if (!EMAIL_RE.test(email) || email.length > 120) return j({ error: 'That email does not look right. Leave it empty to skip.' }, 400);
        await d.prepare('INSERT OR IGNORE INTO sh_suggest_notify (k, email, at) VALUES (?, ?, ?)').bind(n.url, email, now).run();
        notify = true;
      }
      if (fresh) await done(track(env, { name: 'home_suggested', env: environment, source: 'server', actor, path, props: { kind: 'walk:gallery', step: votes === 1 ? 'new' : 'vote', ref: n.host } }).catch(() => {}));
      return j({ ok: true, votes, counted: fresh, host: n.host, notify });
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// A suggested home went live as walk <slug>: mark it built and send each person who left an email one message, then forget the address.
export async function suggestBuilt(env, body, fetchImpl = fetch) {
  const d = await sdb(env);
  const n = normalizePlanUrl(body && body.url), slug = String((body && body.slug) || '');
  if (!d || !n || !/^[a-z0-9-]{3,80}$/.test(slug)) return { ok: false, error: 'url and slug' };
  const row = await d.prepare('SELECT k FROM sh_suggest WHERE k = ?').bind(n.url).first();
  if (!row) return { ok: false, error: 'not suggested' };
  await d.prepare("UPDATE sh_suggest SET status = ? WHERE k = ?").bind('built:' + slug, n.url).run();
  const people = (await d.prepare('SELECT email FROM sh_suggest_notify WHERE k = ?').bind(n.url).all()).results;
  if (!mailMode(env)) return { ok: true, sent: 0, waiting: people.length, note: 'no mail route configured; addresses kept' };
  let sent = 0, failed = 0;
  const text = `The home you asked for is ready to walk:\nhttps://showhaus.app/walk/?p=${slug}\n\nIt is a free base walk made from the published floor plan. Heights, finishes and furniture are estimated.\n\nThis is the only email you get from this request, and your address is now deleted.\n\nSHOWHAUS`;
  for (const p of people) {
    try { await sendMail(env, p.email, 'The home you asked for is ready to walk', text, fetchImpl); sent++; await d.prepare('DELETE FROM sh_suggest_notify WHERE k = ? AND email = ?').bind(n.url, p.email).run(); }
    catch (e) { failed++; console.error('suggest notify', e && e.message); }
  }
  return { ok: true, sent, failed };
}

// The build order the pages promise. base: homes asked for, most votes first. photoreal: live walks, most net votes first
// (a visitor's last vote/cancel counts). finishes: paid by the claimant, oldest first. Private homes are in no lane.
export async function walkQueue(env) {
  const d = await sdb(env);
  if (!d) return null;
  const base = (await d.prepare("SELECT url, host, votes, at, (SELECT COUNT(*) FROM sh_suggest_notify n WHERE n.k = s.k) AS notify FROM sh_suggest s WHERE env = 'production' AND status = 'new' ORDER BY votes DESC, at LIMIT 50").all()).results;
  const ev = (await d.prepare("SELECT name, actor, props FROM sh_events WHERE env = 'production' AND name IN ('upgrade_interest', 'upgrade_interest_cancel') AND actor IS NOT NULL ORDER BY at").all()).results;
  const last = new Map();
  for (const e of ev) {
    let kind = ''; try { kind = JSON.parse(e.props || '{}').kind || ''; } catch { /* skip */ }
    if (kind.startsWith('walk:') && kind !== 'walk:gallery') last.set(kind.slice(5) + '|' + e.actor, e.name === 'upgrade_interest');
  }
  const votes = new Map();
  for (const [key, on] of last) if (on) { const slug = key.split('|')[0]; votes.set(slug, (votes.get(slug) || 0) + 1); }
  const claims = await claimSummary(env).catch(() => null);
  const hidden = new Set(((claims && claims.private) || []).map(p => p.slug));
  const photoreal = [...votes].filter(([slug]) => !hidden.has(slug)).map(([slug, v]) => ({ slug, votes: v })).sort((a, b) => b.votes - a.votes || a.slug.localeCompare(b.slug));
  const finishes = ((claims && claims.finishes) || []).filter(f => (f.status === 'paid' || f.status === 'uploaded') && !hidden.has(f.slug)).sort((a, b) => a.at.localeCompare(b.at));
  return { base, photoreal, finishes };
}

export async function suggestSummary(env) {
  const d = await sdb(env);
  if (!d) return null;
  const homes = (await d.prepare("SELECT url, host, votes, at, status FROM sh_suggest WHERE env = 'production' ORDER BY votes DESC, at LIMIT 50").all()).results;
  const fixes = (await d.prepare("SELECT id, slug, room, note, at, status FROM sh_fixes WHERE env = 'production' ORDER BY at DESC LIMIT 50").all()).results;
  return { homes, fixes };
}
