// SHOWHAUS Hunt board (dist/showhaus/hunt): the homes someone is looking at, from any site, checked and shared. No login.
//   GET  /api/hunt/check?q=<address or listing link>   one NSW address → map point + street checks from public NSW services
//                                                     (zoning, bush fire, flood, Sydney Airport ANEF 2039 + NSW airport noise maps, canopy). A Domain listing link is
//                                                     read for its address (the slug); a link with no street (realestate.com.au)
//                                                     answers { need: 'address', suburb } so the page asks for the street.
//                                                     Nothing is fetched from the listing site itself. Cached a day.
//   GET  /api/hunt/noise?ll=<lng>,<lat>              aircraft noise only (Sydney Airport ANEF 2039 + NSW maps) for one point.
//   POST /api/hunt/board { items, title }            share a board: → { id, edit }. Re-post with { id, edit, items } to update.
//   GET  /api/hunt/board?id=                         { title, items, comments } for anyone with the link.
//   POST /api/hunt/comment { id, key, name, text }   a comment on one home of a shared board (partner, family, friend).
// Rent is not here: the page computes it from the same bond file the map uses (data/rents.json).
import { db, pseudo } from './ops/store.js';
import { track, environmentOf } from './ops/events.js';
import { hit } from './claim.js';
import { normalizeAddress, verifyAddress, lookupAddresses, prettyAddress, inNSW } from './suggest.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sh_claim_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sh_hunt (id TEXT PRIMARY KEY, edit TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, env TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sh_hunt_comments (n INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, item TEXT NOT NULL, name TEXT, text TEXT NOT NULL, at TEXT NOT NULL)`,
];
let ready = null;
async function hdb(env) {
  const d = await db(env);
  if (!d) return null;
  if (!ready) ready = d.batch(SCHEMA.map(s => d.prepare(s))).catch(e => { ready = null; throw e; });
  await ready;
  return d;
}
export function resetHuntForTests() { ready = null; }

const j = (data, status = 200, cache = 'no-store') => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': cache } });
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const CHECKS_PER_HOUR = 120, COMMENTS_PER_HOUR = 30, SHARES_PER_HOUR = 30, MAX_ITEMS = 40;

// ---------- what was pasted → an address the NSW register can find ----------
// Domain: /12-smith-street-blacktown-nsw-2148-2019123456 (street, suburb, postcode, listing id).
// realestate.com.au: /property-house-nsw-blacktown-145123456 (suburb only) → ask for the street.
export function parsePasted(raw) {
  const s = String(raw ?? '').trim().slice(0, 300);
  let u = null; try { if (/^https?:\/\//i.test(s)) u = new URL(s); } catch { /* not a link */ }
  if (!u) return { address: s };
  const host = u.hostname.replace(/^www\./, ''), seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
  if (/(^|\.)domain\.com\.au$/.test(host)) {
    const w = seg.replace(/-\d{6,}$/, '').split('-'), i = w.lastIndexOf('nsw');
    if (i > 1) return { address: w.slice(0, i).join(' ').replace(/^(\d+[a-z]?) (\d+[a-z]?) /, '$1/$2 '), postcode: /^2\d{3}$/.test(w[i + 1] || '') ? w[i + 1] : null, link: host };
    return { need: 'address', link: host };
  }
  if (/(^|\.)realestate\.com\.au$/.test(host)) {
    const m = seg.match(/-nsw-([a-z-]+?)-\d{5,}$/);
    return { need: 'address', suburb: m ? m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null, link: host };
  }
  return { need: 'address', link: host };
}

export const SYD_ANEF = 'https://mapservices.randwick.nsw.gov.au/arcgis/rest/services/intPlanning/ANEF2039/MapServer';
export const SYD_ANEF_LAYERS = [[0, '35+'], [1, '30–35'], [2, '25–30'], [3, '20–25']];
export const SYD_ANEF_PDF = 'https://www.airservicesaustralia.com/wp-content/uploads/Sydney-Airport-ANEF-2039.pdf';

// ---------- NSW point services (same layers as the listing kit, scripts/showhaus-listing-kit.mjs) ----------
export const SVC = {
  zoning: ['NSW Planning Portal — Land Zoning', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer/2/query', 'SYM_CODE,LAY_CLASS'],
  bushfire: ['NSW Planning Portal — Bush Fire Prone Land (RFS certified)', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/229/query', 'd_Category,Category'],
  flood: ['NSW Planning Portal — Flood Planning (state layer; many councils not yet in it)', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/230/query', 'LAY_CLASS,LGA_NAME'],
  anec: ['NSW Planning Portal — Airport Noise (LEP and SEPP maps: Western Sydney Airport ANEC, Bankstown, Cessnock and others)', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Protection/MapServer/2/query', 'ANEF_CODE,EPI_NAME'],
  // Sydney Airport (Mascot) is not in the state layer above: Bayside, Inner West and Randwick LEPs refer to the ANEF map itself.
  // The Airservices-endorsed ANEF 2039 (Sydney Airport Master Plan 2039) is published as GIS by Randwick City Council,
  // one MapServer sub-layer per contour band: 0 = 35+, 1 = 30–35, 2 = 25–30, 3 = 20–25, field `anef`.
  sydney_anef: ['Sydney Airport ANEF 2039 (Airservices-endorsed, Master Plan 2039) — GIS layer published by Randwick City Council', SYD_ANEF + '/{layer}/query', 'anef'],
  canopy: ['NSW Government 2024–25 urban tree canopy', 'https://mapprod2.environment.nsw.gov.au/arcgis/rest/services/UHGC/GSR_2024_VegStrata_H3Z11/MapServer/0/query', 'Canopy_pc'],
};
async function point(fetchImpl, url, fields, [lng, lat]) {
  const q = `${url}?${new URLSearchParams({ where: '1=1', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: fields, returnGeometry: 'false', f: 'json' })}`;
  try {
    const r = await fetchImpl(q, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000), cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) return { ok: false };
    const d = await r.json();
    if (d.error) return { ok: false };
    return { ok: true, rows: (d.features || []).map(f => f.attributes || {}) };
  } catch { return { ok: false }; }
}
// Sydney Airport ANEF 2039: one query per band; the highest band the point falls in. Any band failing = unknown.
export async function sydneyAnef(fetchImpl, lngLat) {
  const rs = await Promise.all(SYD_ANEF_LAYERS.map(([id]) => point(fetchImpl, `${SYD_ANEF}/${id}/query`, 'anef', lngLat)));
  if (rs.some(r => !r.ok)) return { ok: false };
  const i = rs.findIndex(r => r.rows.length);
  return { ok: true, rows: i < 0 ? [] : [{ band: SYD_ANEF_LAYERS[i][1], anef: rs[i].rows[0].anef ?? null }] };
}
// AS 2021 building-site acceptability for houses, by ANEF band.
export function anefMeaning(band) {
  if (band === '20–25') return 'AS 2021 calls a new house here "conditionally acceptable" (noise insulation expected)';
  return 'AS 2021 calls a new house here "unacceptable"';
}
export async function checkPoint(fetchImpl, lngLat) {
  const entries = await Promise.all(Object.entries(SVC).map(async ([k, [, u, f]]) => [k, k === 'sydney_anef' ? await sydneyAnef(fetchImpl, lngLat) : await point(fetchImpl, u, f, lngLat)]));
  return Object.fromEntries(entries);
}

// Raw service rows → the plain-language lines a card shows. Unknown is said as unknown, never as "none".
export function summarise(raw) {
  const out = {};
  const z = raw.zoning; out.zoning = !z.ok ? null : z.rows[0] ? { code: z.rows[0].SYM_CODE || null, name: z.rows[0].LAY_CLASS || null } : { code: null, name: 'Not zoned in the state layer' };
  const b = raw.bushfire; out.bushfire = !b.ok ? null : b.rows.length ? { hit: true, text: `Bush fire prone land${b.rows[0].d_Category ? ' — ' + b.rows[0].d_Category : ''}` } : { hit: false, text: 'Not on bush fire prone land' };
  const f = raw.flood; out.flood = !f.ok ? null : f.rows.length ? { hit: true, text: 'Inside a flood planning area' } : { hit: false, text: 'Not in the state flood layer (some councils are not in it yet)' };
  out.aircraft = aircraft(raw.anec, raw.sydney_anef);
  // Canopy_pc is a share (0–1) of the ~2,600 m² cell the home sits in.
  const c = raw.canopy, cv = c.ok && c.rows.length ? Number(c.rows[0].Canopy_pc) : NaN; out.canopy = Number.isFinite(cv) ? { pct: Math.round(cv <= 1 ? cv * 100 : cv) } : null;
  return out;
}

// Two sources: Sydney Airport ANEF 2039 and the NSW plan maps (Western Sydney ANEC and regional airports).
// A hit in either is a hit. "Outside" is said only when both answered; if one did not, the line says which is unchecked.
export function aircraft(a = { ok: false }, s = { ok: false }) {
  const lep = a.ok && a.rows.length ? a.rows[0] : null, syd = s.ok && s.rows.length ? s.rows[0] : null;
  const lepName = r => /Western Parkland|Aerotropolis/.test(r.EPI_NAME || '') ? 'Western Sydney Airport' : (r.EPI_NAME || 'NSW plan');
  if (syd) return { hit: true, source: 'sydney_anef', band: syd.band, text: `Sydney Airport ANEF 2039 noise contour ${syd.band} — ${anefMeaning(syd.band)}` };
  if (lep) return { hit: true, source: 'anec', band: lep.ANEF_CODE ?? null, text: `${lepName(lep)} aircraft noise contour ${lep.ANEF_CODE ?? ''}`.trim() };
  if (a.ok && s.ok) return { hit: false, text: 'Outside the Sydney Airport ANEF 2039 and Western Sydney Airport noise contours (planes can still be heard outside them)' };
  if (s.ok) return { hit: false, partial: true, text: 'Outside the Sydney Airport ANEF 2039 contours; the Western Sydney Airport map could not be checked just now' };
  if (a.ok) return { hit: false, partial: true, text: 'Outside the Western Sydney Airport noise contours; Sydney Airport (Mascot) ANEF could not be checked just now' };
  return null;
}

async function resolve(parsed, fetchImpl) {
  const norm = normalizeAddress(parsed.address);
  if (!norm) return null;
  const exact = await verifyAddress(norm, fetchImpl).catch(() => null);
  if (exact) return { ...exact, exact: true };
  const near = await lookupAddresses(norm, fetchImpl).catch(() => []);
  return near[0] ? { ...near[0], exact: false } : null;
}

export async function handleHunt(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/hunt/')) return null;
  const fetchImpl = env.__fetch || fetch;
  try {
    const d = await hdb(env);
    if (!d) return j({ error: 'Not available here yet.' }, 503);
    const ip = await pseudo(d, 'ip', request.headers.get('cf-connecting-ip') || 'local');
    const environment = environmentOf(request);

    if (path === '/api/hunt/check' && request.method === 'GET') {
      const parsed = parsePasted(url.searchParams.get('q'));
      if (parsed.need) return j({ need: 'address', suburb: parsed.suburb || null, link: parsed.link || null });
      if (!normalizeAddress(parsed.address)) return j({ need: 'address', error: 'Start with the house or unit number, e.g. 4/12 Smith St Blacktown.' });
      if (!(await hit(d, 'hc:' + ip, CHECKS_PER_HOUR, 3600e3))) return j({ error: 'Too many checks this hour. Try again later.' }, 429);
      const where = await resolve(parsed, fetchImpl);
      if (!where) return j({ need: 'address', error: 'That address is not in the NSW address register. Check the spelling, or try the street without the unit.' });
      const raw = await checkPoint(fetchImpl, where.lngLat);
      const body = {
        address: where.address, label: where.label || prettyAddress(where.address), lngLat: where.lngLat, exact: where.exact,
        postcode: parsed.postcode || null, from: parsed.link || null,
        checks: summarise(raw),
        sources: Object.fromEntries(Object.entries(SVC).map(([k, [n]]) => [k, n])),
        checked: new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }), // YYYY-MM-DD, Sydney date
      };
      ctx && ctx.waitUntil && ctx.waitUntil(track(env, { name: 'hunt_check', env: environment, source: 'server', path, props: { kind: parsed.link ? 'link:' + parsed.link : 'address' } }).catch(() => {}));
      return j(body, 200, 'public, max-age=86400');
    }

    // Aircraft noise at one map point (the /p/ property pages ask this for their own lot point).
    if (path === '/api/hunt/noise' && request.method === 'GET') {
      const ll = String(url.searchParams.get('ll') || '').split(',').map(Number);
      if (ll.length !== 2 || !inNSW(ll[0], ll[1])) return j({ error: 'll=lng,lat inside NSW' }, 400);
      if (!(await hit(d, 'hc:' + ip, CHECKS_PER_HOUR, 3600e3))) return j({ error: 'Too many checks this hour. Try again later.' }, 429);
      const lngLat = ll.map(n => Math.round(n * 1e5) / 1e5);
      const [anec, sydney_anef] = await Promise.all([point(fetchImpl, SVC.anec[1], SVC.anec[2], lngLat), sydneyAnef(fetchImpl, lngLat)]);
      return j({ lngLat, aircraft: aircraft(anec, sydney_anef), raw: { anec, sydney_anef }, sources: { anec: SVC.anec[0], sydney_anef: SVC.sydney_anef[0] }, urls: { sydney_anef: SYD_ANEF, sydney_anef_pdf: SYD_ANEF_PDF, anec: SVC.anec[1].replace(/\/query$/, '') }, checked: new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) }, 200, 'public, max-age=86400');
    }

    if (path === '/api/hunt/board' && request.method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[a-z0-9]{10}$/.test(id)) return j({ error: 'Unknown board.' }, 404);
      const row = await d.prepare('SELECT data, updated FROM sh_hunt WHERE id = ?').bind(id).first();
      if (!row) return j({ error: 'Unknown board.' }, 404);
      const comments = (await d.prepare('SELECT item, name, text, at FROM sh_hunt_comments WHERE board = ? ORDER BY n').bind(id).all()).results || [];
      return j({ ...JSON.parse(row.data), updated: row.updated, comments });
    }

    if (request.method !== 'POST') return j({ error: 'method' }, 405);
    const body = await request.json().catch(() => ({}));

    if (path === '/api/hunt/board') {
      const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean) : null;
      if (!items || !items.length) return j({ error: 'Add a home first.' }, 400);
      const data = JSON.stringify({ title: clean(body.title, 60) || 'Our shortlist', items }), now = new Date().toISOString();
      if (body.id) {
        const row = await d.prepare('SELECT edit FROM sh_hunt WHERE id = ?').bind(String(body.id)).first();
        if (!row || row.edit !== await pseudo(d, 'hunt', String(body.edit || ''))) return j({ error: 'Only the person who shared this board can change it.' }, 403);
        await d.prepare('UPDATE sh_hunt SET data = ?, updated = ? WHERE id = ?').bind(data, now, String(body.id)).run();
        return j({ id: body.id, ok: true });
      }
      if (!(await hit(d, 'hs:' + ip, SHARES_PER_HOUR, 3600e3))) return j({ error: 'Too many boards this hour.' }, 429);
      const id = token(10), edit = token(24);
      await d.prepare('INSERT INTO sh_hunt (id, edit, data, created, updated, env) VALUES (?, ?, ?, ?, ?, ?)').bind(id, await pseudo(d, 'hunt', edit), data, now, now, environment).run();
      ctx && ctx.waitUntil && ctx.waitUntil(track(env, { name: 'hunt_share', env: environment, source: 'server', path, props: { kind: String(items.length) } }).catch(() => {}));
      return j({ id, edit });
    }

    if (path === '/api/hunt/comment') {
      const id = String(body.id || ''), key = clean(body.key, 120), text = clean(body.text, 400), name = clean(body.name, 30);
      if (!/^[a-z0-9]{10}$/.test(id) || !key || !text) return j({ error: 'Write a comment first.' }, 400);
      const row = await d.prepare('SELECT data FROM sh_hunt WHERE id = ?').bind(id).first();
      if (!row || !JSON.parse(row.data).items.some(i => i.key === key)) return j({ error: 'Unknown home.' }, 404);
      if (!(await hit(d, 'hm:' + ip, COMMENTS_PER_HOUR, 3600e3))) return j({ error: 'Too many comments this hour.' }, 429);
      await d.prepare('INSERT INTO sh_hunt_comments (board, item, name, text, at) VALUES (?, ?, ?, ?, ?)').bind(id, key, name || null, text, new Date().toISOString()).run();
      ctx && ctx.waitUntil && ctx.waitUntil(track(env, { name: 'hunt_comment', env: environment, source: 'server', path }).catch(() => {}));
      return j({ ok: true });
    }
    return j({ error: 'not found' }, 404);
  } catch (e) {
    console.error('hunt', e && e.message);
    return j({ error: 'Something went wrong. Try again.' }, 500);
  }
}

// A board item is only what the page shows: no free-form HTML, numbers bounded.
function cleanItem(i) {
  if (!i || typeof i !== 'object') return null;
  const key = clean(i.key, 120); if (!key) return null;
  const ll = Array.isArray(i.lngLat) && i.lngLat.length === 2 && i.lngLat.every(Number.isFinite) ? i.lngLat.map(n => Math.round(n * 1e6) / 1e6) : null;
  const beds = Number.isInteger(i.beds) && i.beds >= 0 && i.beds <= 9 ? i.beds : null;
  const price = Number.isFinite(i.price) && i.price > 0 && i.price < 1e8 ? Math.round(i.price) : null;
  let link = null; try { const u = new URL(String(i.link || '')); if (u.protocol === 'https:') link = u.toString().slice(0, 300); } catch { /* none */ }
  return { key, label: clean(i.label, 120), lngLat: ll, postcode: /^2\d{3}$/.test(String(i.postcode || '')) ? String(i.postcode) : null, beds, price, link, note: clean(i.note, 300), checks: checksOk(i.checks), checked: /^\d{4}-\d{2}-\d{2}$/.test(String(i.checked || '')) ? String(i.checked) : null };
}
function checksOk(c) {
  if (!c || typeof c !== 'object') return null;
  const t = JSON.stringify(c);
  return t.length > 2500 ? null : JSON.parse(t.replace(/[<>]/g, ''));
}
function token(n) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, x => a[x % a.length]).join('');
}
