// SHOWHAUS listing routes (src/listing.js), the shared asset model (dist/showhaus/data/listings.json, l/data/*.json)
// and the approximate ANEF file. Runs the real Worker against the real dist/ files (no network, no Cloudflare account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { legacyRedirect, appPath, withBase, resetListingsForTests } from '../src/listing.js';
import { resetForTests } from '../src/ops/store.js';
import { createRequire } from 'node:module';

const WS = createRequire(import.meta.url)('../dist/showhaus/l/walk-sun.js');

const DIST = new URL('../dist/', import.meta.url);
const read = p => readFileSync(new URL(p, DIST));
const json = p => JSON.parse(read(p));
const index = json('showhaus/data/listings.json');
// The ANEF contours are private (in-c0/spatial-world-engine data/anef/): read them only when that checkout is next to this one.
const ANEF_PATH = process.env.SHOWHAUS_ANEF || new URL('../../spatial-world-engine/data/anef/anef-sydney-approx.geojson', import.meta.url).pathname;
const anef = fs.existsSync(ANEF_PATH) ? JSON.parse(fs.readFileSync(ANEF_PATH, 'utf8')) : null;

// ASSETS stand-in: serves dist/ like Workers static assets (index.html for folders).
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json', js: 'text/javascript', css: 'text/css', geojson: 'application/json' };
const ASSETS = { fetch: async req => {
  let p = decodeURIComponent(new URL(req.url).pathname).replace(/^\//, '');
  if (p.endsWith('/')) p += 'index.html';
  const f = new URL(p, DIST);
  if (!existsSync(f) || p.includes('..')) return new Response('nf', { status: 404 });
  return new Response(readFileSync(f), { headers: { 'content-type': TYPES[p.split('.').pop()] || 'application/octet-stream' } });
} };
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }) });
  return { prepare: sql => stmt(sql), batch: async l => Promise.all(l.map(s => s.run())) };
}
const env = () => { resetForTests(); resetListingsForTests(); return { ASSETS, OPS_DB: d1() }; };
const ctx = { waitUntil() {} };
const get = (u, e = env()) => worker.fetch(new Request(u), e, ctx);

test('the shared model lists Arncliffe Central and the 10 listing kits, each with a page, a claim route and a pin', () => {
  const slugs = index.listings.map(l => l.slug);
  const kits = readdirSync(new URL('showhaus/p/', DIST)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  assert.equal(kits.length, 10);
  assert.ok(slugs.includes('arncliffe-central'));
  for (const k of kits) assert.ok(slugs.includes(k), k);
  for (const L of index.listings) {
    assert.match(L.slug, /^[a-z0-9-]{3,80}$/);
    const [lng, lat] = L.lnglat;
    assert.ok(lng > 150.5 && lng < 151.5 && lat > -34.2 && lat < -33.6, `${L.slug} pin is in Sydney`);
    const page = json(`showhaus/l/data/${L.slug}.json`);
    assert.equal(page.links.page, `/l/${L.slug}`); assert.equal(page.links.claim, `/l/${L.slug}/claim`);
    assert.deepEqual(page.cards.map(c => c.id).filter(id => ['noise', 'satellite', 'planning'].includes(id)).sort(), ['noise', 'planning', 'satellite']);
    for (const c of page.cards) assert.ok(c.source && c.source.label, `${L.slug} ${c.id} names its source`);
  }
});

test('nothing in the model says photoreal; every render slot says generated', () => {
  for (const L of index.listings) {
    const page = json(`showhaus/l/data/${L.slug}.json`);
    assert.equal(page.world.photoreal, false);
    const text = JSON.stringify(page).toLowerCase().replace(/"photoreal":false/g, '');
    assert.ok(!text.includes('photoreal') && !text.includes('photo-real'), `${L.slug} uses the word photoreal`);
    const hero = page.renders.hero;
    if (hero) {
      assert.match(hero.label, /generated/);
      assert.equal(hero.seasons.length, 4);
      assert.deepEqual(hero.seasons.map(s => s.id), ['summer', 'autumn', 'winter', 'spring']);
    }
  }
});

test('ANEF contours are never published: no contour file in dist, the map fetches none, listings carry results only', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(new URL('../dist/showhaus', import.meta.url).pathname);
  assert.deepEqual(files.filter(f => /anef/i.test(path.basename(f))), []);
  const pins = fs.readFileSync(new URL('../dist/showhaus/lib/pins.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pins, /fetch\([^)]*anef/i);
  assert.doesNotMatch(pins, /addSource\(\s*'anef'/);
  for (const f of files.filter(f => f.endsWith('.json'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /"type":\s*"(Multi)?Polygon"[^}]*"anef"|"anef":\s*(20|25|30|35)\s*,\s*"year"/, f);
  for (const L of index.listings) assert.ok(L.anef && '2039' in L.anef && '2045' in L.anef, L.slug);
});

test('ANEF file: labelled approx., not official, with a source, a method and an uncertainty; 4 nested contours per year', { skip: !anef && 'private ANEF checkout not next to this repo' }, () => {
  assert.equal(anef.status, 'approx.'); assert.equal(anef.official, false);
  assert.match(anef.notice, /not the official ANEF/);
  assert.match(anef.source.url, /^https:\/\//); assert.match(anef.source.document, /Master Plan 2045/);
  assert.ok(anef.method.rms_m > 0 && anef.method.uncertainty_m >= 2 * anef.method.rms_m);
  for (const y of [2039, 2045]) {
    const levels = anef.features.filter(f => f.properties.year === y).map(f => f.properties.anef).sort();
    assert.deepEqual(levels, [20, 25, 30, 35]);
  }
  for (const f of anef.features) assert.match(f.properties.label, /\(approx\.\)$/);
  // Sydney Airport (the runways) is inside every ANEF 35 contour.
  const inside = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
  for (const f of anef.features.filter(f => f.properties.anef === 35)) assert.ok(inside([151.1776, -33.9461], f.geometry.coordinates[0]), `${f.properties.label}`);
});

test('noise card: approx. wording, never "official"; Arncliffe matches what its own EIS says (outside ANEF 20, 2039)', () => {
  const a = json('showhaus/l/data/arncliffe-central.json');
  const noise = a.cards.find(c => c.id === 'noise');
  assert.equal(noise.approx, true);
  assert.equal(noise.rows[0].label, 'ANEF 2039'); assert.match(noise.rows[0].value, /^Outside ANEF 20 \(approx\.\)/);
  assert.match(noise.stated.value, /Outside the ANEF 20 contour/);
  for (const L of index.listings) {
    const t = JSON.stringify(json(`showhaus/l/data/${L.slug}.json`).cards.find(c => c.id === 'noise'));
    assert.ok(!/official ANEF(?!\.| published)/i.test(t.replace(/not the official ANEF/g, '')), L.slug);
    assert.match(t, /approx\./);
  }
});

test('old links 301 to /l/<slug>, keeping the visitor\'s other parameters; embeds and the pilot page stay', () => {
  const r = u => legacyRedirect(new URL(u));
  assert.equal(r('https://showhaus.app/p/?a=7-walsh-ave-maroubra'), 'https://showhaus.app/l/7-walsh-ave-maroubra');
  assert.equal(r('https://showhaus.app/studio/?p=arncliffe-central&by=abc234&src=share'), 'https://showhaus.app/l/arncliffe-central?by=abc234&src=share');
  assert.equal(r('https://x.workers.dev/showhaus/p/?a=8-knox-st-clovelly'), 'https://x.workers.dev/showhaus/l/8-knox-st-clovelly');
  assert.equal(r('https://showhaus.app/studio/?p=arncliffe-central&embed=1'), null);
  assert.equal(r('https://showhaus.app/studio/pilot.html'), null);
  assert.equal(r('https://showhaus.app/p/?a=../../etc'), null);
  assert.equal(r('https://map.lifeos.studio/p/?a=7-walsh-ave-maroubra'), null); // the atlas host is untouched
  assert.equal(appPath(new URL('https://map.lifeos.studio/l/x')), null);
});

test('worker: /p/?a= and /studio/?p= answer 301; /studio/pilot.html still serves', async () => {
  const p = await get('https://showhaus.app/p/?a=7-walsh-ave-maroubra');
  assert.equal(p.status, 301); assert.equal(p.headers.get('location'), 'https://showhaus.app/l/7-walsh-ave-maroubra');
  const s = await get('https://showhaus.app/studio/?p=arncliffe-central');
  assert.equal(s.status, 301); assert.equal(s.headers.get('location'), 'https://showhaus.app/l/arncliffe-central');
  const pilot = await get('https://showhaus.app/studio/pilot.html');
  assert.equal(pilot.status, 200);
  const embed = await get('https://showhaus.app/studio/?p=arncliffe-central&embed=1');
  assert.equal(embed.status, 200);
});

test('worker: /l/<slug> serves the listing page with a base href; unknown slugs 404', async () => {
  const r = await get('https://showhaus.app/l/arncliffe-central');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<base href="\/l\/">/);
  assert.match(html, /listing\.js/);
  const other = await get('https://x.workers.dev/showhaus/l/14-ethel-st-randwick');
  assert.match(await other.text(), /<base href="\/showhaus\/l\/">/);
  assert.equal((await get('https://showhaus.app/l/not-a-place')).status, 404);
  assert.equal((await get('https://showhaus.app/l/../etc')).status !== 200, true);
});

test('worker: /l/<slug>/claim serves the existing claim flow for that listing (no new accounts or providers)', async () => {
  const r = await get('https://showhaus.app/l/7-walsh-ave-maroubra/claim?utm_source=email');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<base href="\/claim\/">/);
  assert.match(html, /Do you or your agency own or market this property\?/);
  // the claim API recognises listing-kit slugs from the shared model, not only studio projects
  const st = await get('https://showhaus.app/api/claim/state?p=7-walsh-ave-maroubra');
  assert.equal(st.status, 200);
  assert.equal((await st.json()).property.name, '7 Walsh Avenue');
});

test('worker: /agent and /agency are the same read-only page; / still serves the map with the pin layer', async () => {
  for (const p of ['/agent', '/agency', '/agency/']) {
    const r = await get('https://showhaus.app' + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /<base href="\/agent\/">/); assert.ok(!/<form/i.test(html), 'read only: no forms');
  }
  const home = await (await get('https://showhaus.app/')).text();
  assert.match(home, /lib\/pins\.js/);
});

test('share links land on the listing page', async () => {
  const r = await get('https://showhaus.app/s/arncliffe-central/abc234');
  assert.equal(r.headers.get('location'), 'https://showhaus.app/l/arncliffe-central?by=abc234&src=share');
});

test('withBase only adds a <base> after <head>', () => {
  assert.equal(withBase('<html><head><title>x</title>', '/l/'), '<html><head>\n<base href="/l/"><title>x</title>');
});

// ---------- the walk's light (world.json "splats": one day, a few states; the Site Walk viewer's splat mode) ----------
const SPLATS = { frame: 'gltf', day: '2026-11-08', provenance: 'generated', label: 'generated', states: [
  { id: 'sunset', label: 'Sunset', local_time: '19:31', t: 0.98, street: 's.spz', interior: null },
  { id: 'sunrise', label: 'Sunrise', local_time: '05:55', t: 0.02, street: 'a.spz', interior: 'b.spz' },
  { id: 'midday', label: 'Midday', local_time: '12:43', t: 0.5, street: 'c.spz', interior: null },
  { id: 'golden', label: 'Golden hour', local_time: '18:40', t: 0.9, street: 'd.spz', interior: null },
  { id: 'Bad Id', t: 0.4, street: 'x.spz' }, { id: 'late', t: 2, street: 'y.spz' },
] };

test('walk light: states are read from the world file, sorted, bad ones dropped; the day reads as a date', () => {
  const st = WS.splatStates(SPLATS);
  assert.deepEqual(st.map(s => s.id), ['sunrise', 'midday', 'golden', 'sunset']);
  assert.deepEqual(WS.splatStates(null), []);
  assert.deepEqual(WS.splatStates({ states: 'x' }), []);
  assert.equal(WS.fmtDay('2026-11-08'), '8 Nov 2026');
  assert.equal(WS.fmtDay('soon'), null);
});

test('walk light: the walk opens on the state nearest the hero sun dot (fraction of the day, sunrise → sunset)', () => {
  const st = WS.splatStates(SPLATS);
  for (const [f, id] of [[0, 'sunrise'], [0.2, 'sunrise'], [0.27, 'midday'], [0.69, 'midday'], [0.71, 'golden'], [0.93, 'golden'], [0.95, 'sunset'], [1, 'sunset']])
    assert.equal(WS.nearestState(st, f).id, id, `f=${f}`);
  assert.equal(WS.nearestState([], 0.5), null);
});

test('walk light: the viewer URL carries sun=<id>; the walk stays gated by hosted (or a same-origin preview) exactly as before', () => {
  const href = 'https://showhaus.app/l/arncliffe-central';
  const hosted = { hosted: true, viewer: '/walk/viewer/', url: '/worlds/arncliffe-central/world.json' };
  const u = new URL(WS.walkHref(hosted, new URLSearchParams(), href, 'walk', 'golden'));
  assert.equal(u.pathname, '/walk/viewer/');
  assert.deepEqual([u.searchParams.get('static'), u.searchParams.get('intent'), u.searchParams.get('sun'), u.searchParams.get('noflash')],
    ['https://showhaus.app/worlds/arncliffe-central/world.json', 'walk', 'golden', '1']);
  assert.equal(new URL(WS.walkHref(hosted, new URLSearchParams(), href, 'inside', null)).searchParams.has('sun'), false);
  assert.equal(new URL(WS.walkHref(hosted, new URLSearchParams(), href, 'walk', '"><x')).searchParams.has('sun'), false);
  assert.equal(WS.walkHref({ ...hosted, hosted: false }, new URLSearchParams(), href, 'walk', 'golden'), null);
  assert.equal(WS.walkHref({ ...hosted, viewer: 'https://elsewhere.test/v/' }, new URLSearchParams(), href, 'walk'), null);
  const preview = new URLSearchParams('viewer=/walk/viewer/&world=/worlds/x/world.json');
  assert.ok(WS.walkHref({ hosted: false }, preview, href, 'walk', 'sunset').includes('sun=sunset'));
  assert.equal(WS.walkHref({ hosted: false }, new URLSearchParams('viewer=https://evil.test/&world=/w.json'), href, 'walk'), null);
  const page = json('showhaus/l/data/arncliffe-central.json');
  assert.equal(WS.walkHref(page.world, new URLSearchParams(), href, 'walk', 'golden'), page.world.hosted ? WS.walkHref(page.world, new URLSearchParams(), href, 'walk', 'golden') : null);
});

test('walk light: only the viewer frame on this origin is heard; the message shape matches the viewer', () => {
  const frame = {};
  const ok = { origin: 'https://showhaus.app', source: frame, data: { type: 'showhaus:sun', id: 'golden' } };
  const opts = { origin: 'https://showhaus.app', source: frame };
  assert.equal(WS.readSunMessage(ok, opts), 'golden');
  assert.equal(WS.readSunMessage({ ...ok, origin: 'https://evil.test' }, opts), null);
  assert.equal(WS.readSunMessage({ ...ok, source: {} }, opts), null);
  assert.equal(WS.readSunMessage(ok, { origin: 'https://showhaus.app', source: null }), null);
  assert.equal(WS.readSunMessage({ ...ok, data: { type: 'showhaus:sun', id: '<b>' } }, opts), null);
  assert.equal(WS.readSunMessage({ ...ok, data: 'showhaus:sun' }, opts), null);
  assert.deepEqual(WS.sunMessage('sunset'), { type: 'showhaus:sun', id: 'sunset' });
});

test('walk light: the listing page loads walk-sun.js before listing.js and keeps the four season buttons', () => {
  const html = read('showhaus/l/index.html').toString();
  assert.ok(html.indexOf('./walk-sun.js') > 0 && html.indexOf('./walk-sun.js') < html.indexOf('./listing.js'));
  assert.match(html, /id="walkDay"/); assert.match(html, /id="walkSun"/);
  const js = read('showhaus/l/listing.js').toString();
  assert.match(js, /id: 'summer'[\s\S]*id: 'autumn'[\s\S]*id: 'winter'[\s\S]*id: 'spring'/);
  assert.match(js, /readSunMessage\(e, \{ origin: location\.origin, source: \$\('walkFrame'\)\.contentWindow \}\)/);
});
