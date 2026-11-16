// SHOWHAUS — community input with no login (dist/showhaus/walk):
//   POST /api/suggest/home { url, anon }        "walk this home next": a link to a floor plan that is already published
//                                               (a builder's or agent's page). Links only — no file is accepted, stored or
//                                               rendered, and no submitted link is shown to other visitors. The same link from
//                                               different visitors adds up as votes; the build queue reads the totals.
//   POST /api/suggest/home { address, anon }    the same, by street address (NSW). Checked against the NSW address register
//                                               (GURAS, NSW Spatial Services) for a map point; an address it does not know yet
//                                               (new off-the-plan lots) is still kept, marked unverified.
//   GET  /api/suggest/address?q=12 forest rd    address autocomplete: up to 6 NSW addresses with a map point. Proxied here so
//                                               the visitor's connection never reaches a third party; cached a day.
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
  `CREATE TABLE IF NOT EXISTS sh_suggest_geo (k TEXT PRIMARY KEY, lng REAL, lat REAL, verified INTEGER NOT NULL DEFAULT 0)`, // address suggestions only
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

// ---- street addresses (NSW) ----
// GURAS stores "199 FOREST ROAD ARNCLIFFE" / "1/229 FOREST ROAD ARNCLIFFE": upper case, road type spelled out, no state or postcode.
export const GURAS = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/FeatureServer/1/query';
const ROAD = { RD: 'ROAD', ST: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', PDE: 'PARADE', HWY: 'HIGHWAY', CRES: 'CRESCENT', CR: 'CRESCENT', CL: 'CLOSE', CT: 'COURT', DR: 'DRIVE', PL: 'PLACE', TCE: 'TERRACE', LN: 'LANE', CCT: 'CIRCUIT', BVD: 'BOULEVARD', BLVD: 'BOULEVARD', GR: 'GROVE', GRV: 'GROVE', SQ: 'SQUARE', ESP: 'ESPLANADE', WY: 'WAY', WAY: 'WAY', PKWY: 'PARKWAY', CWY: 'CLOSEWAY', RDGE: 'RIDGE', RISE: 'RISE', ROW: 'ROW', LOOP: 'LOOP', MEWS: 'MEWS', TRL: 'TRAIL', ARC: 'ARCADE', AL: 'ALLEY', GDNS: 'GARDENS', HTS: 'HEIGHTS', VW: 'VIEW', VWS: 'VIEWS', WK: 'WALK', BWK: 'BOARDWALK' };
const ROAD_WORDS = new Set(Object.values(ROAD).concat(['CIRCUS', 'GLEN', 'GREEN', 'PATH', 'PROMENADE', 'QUAY', 'RETREAT', 'TRACK', 'VISTA']));
const NSW_BOX = { w: 140.9, e: 153.7, s: -37.6, n: -28.1 };
export const inNSW = (lng, lat) => Number.isFinite(lng) && Number.isFinite(lat) && lng >= NSW_BOX.w && lng <= NSW_BOX.e && lat >= NSW_BOX.s && lat <= NSW_BOX.n;

// What a person types → the register's form. Starts with the house (or unit/house) number; null if it does not.
export function normalizeAddress(raw) {
  let s = String(raw ?? '').toUpperCase().replace(/[‘’`]/g, "'").replace(/[,.;]/g, ' ');
  s = s.replace(/\bAUSTRALIA\b/g, ' ').replace(/\bN\s*S\s*W\b|\bNEW SOUTH WALES\b/g, ' ').replace(/\b2\d{3}\s*$/, ' ');
  s = s.replace(/\s*\/\s*/g, '/').replace(/^(UNIT|APT|APARTMENT|LOT|SHOP|SUITE)\s+(\d+[A-Z]?)\s+/, '$2/');
  s = s.replace(/[^A-Z0-9 '\/-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^\d+[A-Z]?(\/\d+[A-Z]?)?(-\d+[A-Z]?)? [A-Z']/.test(s) || s.length < 5 || s.length > 100) return null;
  return s.split(' ').map((w, i) => (i > 0 && ROAD[w] ? ROAD[w] : w)).join(' ');
}
// "199 FOREST ROAD ARNCLIFFE" → "199 Forest Road, Arncliffe NSW" (suburb split after the last road word).
export function prettyAddress(a) {
  const w = String(a || '').split(' ');
  let cut = -1; w.forEach((x, i) => { if (i > 1 && ROAD_WORDS.has(x) && i < w.length - 1) cut = i; });
  const t = x => x.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/^Mc([a-z])/, (m, c) => 'Mc' + c.toUpperCase());
  const street = w.slice(0, cut + 1 || w.length).map(t).join(' '), suburb = cut >= 0 ? w.slice(cut + 1).map(t).join(' ') : '';
  return suburb ? `${street}, ${suburb} NSW` : `${street} NSW`;
}
async function guras(where, n, fetchImpl) {
  const q = new URLSearchParams({ where, outFields: 'address', outSR: '4326', resultRecordCount: String(n), orderByFields: 'address', f: 'json' });
  const r = await fetchImpl(GURAS + '?' + q, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000), cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) throw new Error('guras ' + r.status);
  const d = await r.json();
  if (d.error) throw new Error('guras ' + (d.error.message || 'error'));
  const seen = new Set(), out = [];
  for (const f of d.features || []) {
    const a = f.attributes && f.attributes.address, g = f.geometry || {};
    if (!a || seen.has(a) || !inNSW(g.x, g.y)) continue;
    seen.add(a); out.push({ address: a, label: prettyAddress(a), lngLat: [Math.round(g.x * 1e6) / 1e6, Math.round(g.y * 1e6) / 1e6] });
  }
  return out;
}
const sqlq = s => "'" + s.replace(/'/g, "''") + "'";
// Sydney first: take a wider page from the register, then the six closest to the CBD (SHOWHAUS is Sydney-first, NSW-wide).
const SYD = [151.207, -33.868], d2 = p => (p[0] - SYD[0]) ** 2 + (p[1] - SYD[1]) ** 2;
export const lookupAddresses = async (norm, fetchImpl = fetch) => (await guras(`address LIKE ${sqlq(norm + '%')}`, 40, fetchImpl)).sort((a, b) => d2(a.lngLat) - d2(b.lngLat)).slice(0, 6);
export const verifyAddress = async (norm, fetchImpl = fetch) => (await guras(`address = ${sqlq(norm)}`, 1, fetchImpl))[0] || null;
export const AC_PER_HOUR = 240;

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
    if (path === '/api/suggest/address' && request.method === 'GET') {
      const norm = normalizeAddress(url.searchParams.get('q'));
      if (!norm) return j({ results: [], hint: 'Start with the house number, e.g. 12 Forest Rd, Arncliffe.' });
      const ip = await pseudo(d, 'ip', request.headers.get('cf-connecting-ip') || 'local');
      if (!(await hit(d, 'ac:' + ip, AC_PER_HOUR, 3600e3))) return j({ results: [], error: 'Too many lookups. Type the full address instead.' }, 429);
      try {
        const results = await lookupAddresses(norm, env.__fetch || fetch);
        return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' } });
      } catch (e) { console.error('suggest address', e && e.message); return j({ results: [], offline: true }); }
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
      let n = null, geo = null;
      if (body.address != null && body.url == null) {
        const norm = normalizeAddress(body.address);
        if (!norm || norm.split(' ').length < 3) return j({ error: 'Type the full address: number, street and suburb.' }, 400);
        let hitGeo = null, checked = false;
        try { hitGeo = await verifyAddress(norm, env.__fetch || fetch); checked = true; } catch (e) { console.error('suggest verify', e && e.message); }
        // Not in the register (yet): new lots often are not. Keep it, unverified, with no map point.
        geo = hitGeo ? { lng: hitGeo.lngLat[0], lat: hitGeo.lngLat[1], verified: 1 } : { lng: null, lat: null, verified: 0, checked };
        n = { key: 'addr:' + norm, url: hitGeo ? hitGeo.label : prettyAddress(norm), host: 'address' };
      } else {
        const u = normalizePlanUrl(body.url);
        if (!u) return j({ error: 'Type the home\u2019s address, or paste the link to the page that shows its floor plan.' }, 400);
        n = { key: u.url, url: u.url, host: u.host };
      }
      await d.prepare('INSERT INTO sh_suggest (k, url, host, at, env) VALUES (?, ?, ?, ?, ?) ON CONFLICT(k) DO NOTHING').bind(n.key, n.url, n.host, now, environment).run();
      if (geo) await d.prepare('INSERT INTO sh_suggest_geo (k, lng, lat, verified) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET lng = COALESCE(excluded.lng, lng), lat = COALESCE(excluded.lat, lat), verified = MAX(verified, excluded.verified)').bind(n.key, geo.lng, geo.lat, geo.verified).run();
      const added = await d.prepare('INSERT OR IGNORE INTO sh_suggest_votes (k, voter, at) VALUES (?, ?, ?)').bind(n.key, voter, now).run();
      const fresh = !!(added.meta && added.meta.changes);
      if (fresh) await d.prepare('UPDATE sh_suggest SET votes = votes + 1 WHERE k = ?').bind(n.key).run();
      const votes = (await d.prepare('SELECT votes FROM sh_suggest WHERE k = ?').bind(n.key).first())?.votes || 1;
      let notify = false;
      const email = String(body.email || '').trim().toLowerCase();
      if (email) {
        if (!EMAIL_RE.test(email) || email.length > 120) return j({ error: 'That email does not look right. Leave it empty to skip.' }, 400);
        await d.prepare('INSERT OR IGNORE INTO sh_suggest_notify (k, email, at) VALUES (?, ?, ?)').bind(n.key, email, now).run();
        notify = true;
      }
      if (fresh) await done(track(env, { name: 'home_suggested', env: environment, source: 'server', actor, path, props: { kind: 'walk:gallery', step: votes === 1 ? 'new' : 'vote', ref: n.host, method: geo ? (geo.verified ? 'address' : 'address:unverified') : 'link' } }).catch(() => {}));
      return j({ ok: true, votes, counted: fresh, host: n.host, notify, ...(geo ? { address: n.url, verified: !!geo.verified } : {}) });
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
// The key a built report names: a plan link (any spelling of it), or the address key `addr:…` that walkQueue hands out.
export function suggestionKey(raw) {
  const v = String(raw ?? '').trim();
  if (/^addr:/i.test(v)) { const a = normalizeAddress(v.slice(5)); return a ? 'addr:' + a : null; }
  const u = normalizePlanUrl(v); return u ? u.url : null;
}
export async function suggestBuilt(env, body, fetchImpl = fetch) {
  const d = await sdb(env);
  const key = suggestionKey(body && (body.key || body.url)), slug = String((body && body.slug) || '');
  if (!d || !key || !/^[a-z0-9-]{3,80}$/.test(slug)) return { ok: false, error: 'url and slug' };
  const n = { url: key };
  const row = await d.prepare('SELECT k FROM sh_suggest WHERE k = ?').bind(n.url).first();
  if (!row) return { ok: false, error: 'not suggested' };
  await d.prepare("UPDATE sh_suggest SET status = ? WHERE k = ?").bind('built:' + slug, n.url).run();
  const people = (await d.prepare('SELECT email FROM sh_suggest_notify WHERE k = ?').bind(n.url).all()).results;
  if (!mailMode(env)) return { ok: true, sent: 0, waiting: people.length, note: 'no mail route configured; addresses kept' };
  let sent = 0, failed = 0;
  const text = `The home you asked for is ready to walk:\nhttps://showhaus.app/walk/?p=${slug}\n\n${key.startsWith('addr:') ? 'It is a free base walk. With no floor plan on file, the layout is estimated from satellite imagery, so rooms may differ from the real home.' : 'It is a free base walk made from the published floor plan. Heights, finishes and furniture are estimated.'}\n\nThis is the only email you get from this request, and your address is now deleted.\n\nSHOWHAUS`;
  for (const p of people) {
    try { await sendMail(env, p.email, 'The home you asked for is ready to walk', text, fetchImpl); sent++; await d.prepare('DELETE FROM sh_suggest_notify WHERE k = ? AND email = ?').bind(n.url, p.email).run(); }
    catch (e) { failed++; console.error('suggest notify', e && e.message); }
  }
  return { ok: true, sent, failed };
}

// The build order the pages promise. base: homes asked for, most votes first. photoreal: live walks, most net votes first
// (a visitor's last vote/cancel counts). finishes: paid by the claimant, oldest first. Private homes are in no lane.
function shapeRow(r) {
  const { k, lng, lat, verified, ...rest } = r;
  if (r.host !== 'address') return { kind: 'link', key: k, ...rest };
  const { url, ...o } = rest;
  return { kind: 'address', key: k, address: url, lngLat: lng != null && lat != null ? [lng, lat] : null, verified: !!verified, ...o };
}
export async function walkQueue(env) {
  const d = await sdb(env);
  if (!d) return null;
  // A link row: { kind: 'link', key, url, host }. An address row: { kind: 'address', key: 'addr:…', address, lngLat | null, verified }
  // — no plan on file, so its base walk is the satellite estimate (listing.source = 'estimate'). `key` is what suggest-built takes.
  const base = (await d.prepare("SELECT s.k, s.url, s.host, s.votes, s.at, g.lng, g.lat, g.verified, (SELECT COUNT(*) FROM sh_suggest_notify n WHERE n.k = s.k) AS notify FROM sh_suggest s LEFT JOIN sh_suggest_geo g ON g.k = s.k WHERE s.env = 'production' AND s.status = 'new' ORDER BY s.votes DESC, s.at LIMIT 50").all()).results.map(shapeRow);
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
  const homes = (await d.prepare("SELECT s.k, s.url, s.host, s.votes, s.at, s.status, g.lng, g.lat, g.verified FROM sh_suggest s LEFT JOIN sh_suggest_geo g ON g.k = s.k WHERE s.env = 'production' ORDER BY s.votes DESC, s.at LIMIT 50").all()).results.map(shapeRow);
  const fixes = (await d.prepare("SELECT id, slug, room, note, at, status FROM sh_fixes WHERE env = 'production' ORDER BY at DESC LIMIT 50").all()).results;
  return { homes, fixes };
}
