// Outside judge for the integrated SHOWHAUS preview: map pins + noise lens on /, /l/<slug>, /l/<slug>/claim, /agent, /agency,
// legacy redirects, and (when a pre-baked world is given) the Site Walk viewer opened from the listing page.
// Runs the real Worker (src/worker.js) behind a local Node server with an in-memory D1, so routes and redirects are the
// production code. Headless Chromium at 1440×900 and 390×844.
//   node scripts/showhaus-listing-judge.mjs [--shots dir]
//        [--engine ../spatial-world-engine]  [--world <folder with world.json>]   (both local only; nothing is published)
// Without --engine/--world the walk checks are skipped and say so.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const arg = k => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const shots = arg('--shots'), engine = arg('--engine') && resolve(arg('--engine')), worldDir = arg('--world') && resolve(arg('--world'));
if (shots) await mkdir(shots, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.geojson': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.glb': 'model/gltf-binary' };
const listings = JSON.parse(await readFile(join(DIST, 'showhaus/data/listings.json'), 'utf8')).listings;

async function file(root, rel) {
  const p = rel === '' ? '' : normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const f = join(root, p === '' || p === '.' || p.endsWith('/') ? join(p, 'index.html') : p);
  if (!f.startsWith(root) || !existsSync(f)) return null;
  return new Response(await readFile(f), { headers: { 'content-type': TYPES[extname(f)] || 'application/octet-stream' } });
}
const ASSETS = { fetch: async req => (await file(DIST, decodeURIComponent(new URL(req.url).pathname).slice(1))) || new Response('nf', { status: 404 }) };
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }) });
  return { prepare: sql => stmt(sql), batch: async l => Promise.all(l.map(s => s.run())) };
}
const env = { ASSETS, OPS_DB: d1() };
const ctx = { waitUntil() {} };

// The local stand-in for showhaus.app: Worker for everything, plus /walk/{viewer,client}/ and /worlds/<slug>/ when given.
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let r = null;
  if (engine && u.pathname.startsWith('/walk/viewer/')) r = await file(join(engine, 'services/viewer/'), u.pathname.slice('/walk/viewer/'.length));
  else if (engine && u.pathname.startsWith('/walk/client/')) r = await file(join(engine, 'packages/jit_client/'), u.pathname.slice('/walk/client/'.length));
  else if (worldDir && u.pathname.startsWith('/worlds/arncliffe-central/')) r = await file(worldDir + '/', u.pathname.slice('/worlds/arncliffe-central/'.length));
  if (!r) {
    const body = req.method === 'POST' ? await new Promise(ok => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => ok(Buffer.concat(c))); }) : undefined;
    // Answer as showhaus.app so host routing is the production one.
    r = await worker.fetch(new Request('https://showhaus.app' + u.pathname + u.search, { method: req.method, headers: { ...req.headers, host: 'showhaus.app', ...(req.headers.origin ? { origin: 'https://showhaus.app' } : {}) }, body, duplex: 'half' }), env, ctx);
  }
  const loc = r.headers.get('location');
  const headers = Object.fromEntries(r.headers);
  if (loc) headers.location = loc.replace('https://showhaus.app', `http://127.0.0.1:${server.address().port}`);
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const skip = name => console.log(`SKIP  ${name}`);
const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ignorable = t => /openfreemap|unpkg|jsdelivr|fonts\.g|net::ERR|Failed to load resource|posthog|WebGL|GPU stall/i.test(t);

async function overflow(page) {
  return page.evaluate(() => document.scrollingElement.scrollWidth > innerWidth + 1);
}

// ---------- redirects (no browser) ----------
for (const [from, to] of [['/p/?a=7-walsh-ave-maroubra', '/l/7-walsh-ave-maroubra'], ['/studio/?p=arncliffe-central', '/l/arncliffe-central']]) {
  const r = await fetch(BASE + from, { redirect: 'manual' });
  check(`${from} → 301 ${to}`, r.status === 301 && r.headers.get('location') === BASE + to, `${r.status} ${r.headers.get('location')}`);
}
{
  const r = await fetch(BASE + '/studio/pilot.html', { redirect: 'manual' });
  check('/studio/pilot.html still serves', r.status === 200);
}

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const tag = `${w}×${h}`;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !ignorable(m.text())) errors.push(m.text()); });

  // ---------- / : pins + noise lens ----------
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const mapOk = await page.waitForFunction(() => window.SHOWHAUS_PINS && window.SHOWHAUS_PINS.state.ready, null, { timeout: 30000 }).then(() => true).catch(() => false);
  if (!mapOk) skip(`${tag} / map did not reach a loaded style here (tiles blocked?) — pin layer checks need the basemap`);
  else {
    const pins = await page.evaluate(() => window.SHOWHAUS.map.getLayer('listing-pin') ? window.SHOWHAUS_PINS.state.listings.length : 0);
    check(`${tag} / pin layer holds every listing`, pins === listings.length, `${pins} of ${listings.length}`);
    // Act 1's question sits over the middle of the map: pick a place and go to act 4 (the map is clear), then centre the pin.
    await page.fill('#where', 'Arncliffe'); await page.keyboard.press('Enter');
    await page.click('[data-go="3"]').catch(() => {}); await page.click('[data-go="4"]').catch(() => {});
    await page.evaluate(() => { const L = window.SHOWHAUS_PINS.state.listings.find(x => x.slug === 'arncliffe-central'); window.SHOWHAUS.map.jumpTo({ center: L.lnglat, zoom: 14 }); });
    // Pan the pin to a spot no panel covers (what a person does), trying a few places on the open map.
    await page.evaluate(() => {
      const m = window.SHOWHAUS.map, L = window.SHOWHAUS_PINS.state.listings.find(x => x.slug === 'arncliffe-central');
      for (const [fx, fy] of [[.5, .2], [.8, .25], [.2, .3], [.5, .35], [.85, .5], [.15, .55]]) {
        const p = m.project(L.lnglat), want = [innerWidth * fx, innerHeight * fy];
        m.panBy([p.x - want[0], p.y - want[1]], { duration: 0 });
        const q = m.project(L.lnglat), el = document.elementFromPoint(q.x, q.y);
        if (el && el.tagName === 'CANVAS') return;
      }
    });
    await page.waitForTimeout(800);
    const pt = await page.evaluate(() => { const L = window.SHOWHAUS_PINS.state.listings.find(x => x.slug === 'arncliffe-central'); const p = window.SHOWHAUS.map.project(L.lnglat); const r = window.SHOWHAUS.map.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y, top: (document.elementFromPoint(r.left + p.x, r.top + p.y) || {}).tagName }; });
    await page.mouse.click(pt.x, pt.y);
    const card = await page.locator('#pinCard').isVisible().catch(() => false);
    check(`${tag} / tapping the Arncliffe pin opens its card`, card && (await page.locator('#pinCard h2').innerText()) === 'Arncliffe Central', `tapped ${pt.top}`);
    if (card) {
      const href = await page.locator('#pinCard .pc-open').getAttribute('href');
      check(`${tag} / the card links to /l/arncliffe-central`, href === BASE + '/l/arncliffe-central', href);
      check(`${tag} / the card says the noise reading is approx.`, /approx\./.test(await page.locator('#pinCard').innerText()));
      await page.click('#pinCard .pc-x');
    }
    await page.click('#noiseLens');
    const paint = () => page.evaluate(() => JSON.stringify(window.SHOWHAUS.map.getPaintProperty('listing-pin', 'circle-color')));
    const key = await page.locator('#noiseKey').innerText();
    check(`${tag} / noise lens tints the pins and says approx. / not official`, (await paint()).includes('anef2039') && /Approx\./.test(key) && /Not the official ANEF/.test(key));
    check(`${tag} / noise lens draws no contours (they are private)`, await page.evaluate(() => !window.SHOWHAUS.map.getSource('anef')));
    await page.click('#noiseKey [data-year="2045"]');
    check(`${tag} / noise lens switches to ANEF 2045`, (await paint()).includes('anef2045'));
    if (shots) await page.screenshot({ path: `${shots}/home-noise-${tag}.png` });
  }
  check(`${tag} / no horizontal scroll`, !(await overflow(page)));

  // ---------- /l/<slug> ----------
  for (const slug of ['arncliffe-central', '7-walsh-ave-maroubra']) {
    await page.goto(`${BASE}/l/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.state !== 'loading', null, { timeout: 15000 });
    const L = listings.find(x => x.slug === slug);
    check(`${tag} /l/${slug} loads its name`, (await page.locator('#name').innerText()) === L.name);
    check(`${tag} /l/${slug} has 4 season buttons`, await page.locator('.season').count() === 4);
    const stamp = await page.locator('#heroStamp').innerText();
    check(`${tag} /l/${slug} hero is labelled generated`, /^generated/.test(stamp), stamp);
    const body = (await page.locator('body').innerText()).toLowerCase();
    check(`${tag} /l/${slug} never says photoreal`, !body.includes('photoreal') && !body.includes('photo-real'));
    const cards = await page.locator('.card').evaluateAll(els => els.map(e => e.dataset.card));
    check(`${tag} /l/${slug} noise, aerial and planning cards`, ['noise', 'satellite', 'planning'].every(c => cards.includes(c)), cards.join(','));
    check(`${tag} /l/${slug} noise card says approx.`, /approx\./.test(await page.locator('[data-card="noise"]').innerText()));
    const read1 = await page.locator('#sunRead').innerText();
    await page.click('.season[data-season="winter"]');
    await page.waitForTimeout(300);
    const winter = await page.evaluate(() => window.SHOWHAUS_LISTING.sun);
    check(`${tag} /l/${slug} winter day is shorter than spring (computed sun)`, winter.set - winter.rise < 11 * 60 && /sunrise/.test(read1), `${winter.set - winter.rise} min`);
    check(`${tag} /l/${slug} the walk is not offered until published`, await page.locator('#walk').isDisabled() && /real place|no walk/i.test(await page.locator('#worldNote').innerText()));
    check(`${tag} /l/${slug} no horizontal scroll`, !(await overflow(page)));
    if (shots) await page.screenshot({ path: `${shots}/l-${slug}-${tag}.png`, fullPage: true });
  }

  // ---------- claim, agent, agency ----------
  await page.goto(`${BASE}/l/7-walsh-ave-maroubra/claim?utm_source=judge&synthetic=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  check(`${tag} /l/<slug>/claim asks the one question`, (await page.locator('h1').innerText()).includes('own or market this property'));
  check(`${tag} /l/<slug>/claim is for that listing`, /7 Walsh Avenue/i.test(await page.locator('#paddr').innerText()), await page.locator('#paddr').innerText());
  await page.click('#yes');
  check(`${tag} /l/<slug>/claim → sign up or claim as guest`, await page.locator('#s-mode').isVisible() && /Claim as guest/.test(await page.locator('#s-mode').innerText()));
  check(`${tag} /l/<slug>/claim no horizontal scroll`, !(await overflow(page)));
  for (const p of ['/agent', '/agency']) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#tbl tbody tr').length > 0, null, { timeout: 8000 }).catch(() => {});
    const rows = await page.locator('#tbl tbody tr').count();
    check(`${tag} ${p} lists every listing, read only`, rows === listings.length && await page.locator('form, input').count() === 0, `${rows}`);
    check(`${tag} ${p} marks its own role`, (await page.locator('nav [aria-current="page"]').innerText()).toLowerCase() === p.slice(1));
    if (shots) await page.screenshot({ path: `${shots}/${p.slice(1)}-${tag}.png`, fullPage: true });
  }

  // ---------- the walk (local pre-baked world; never published) ----------
  if (!engine || !worldDir) skip(`${tag} walk: pass --engine and --world to open the pre-baked world from the listing page`);
  else {
    await page.goto(`${BASE}/l/arncliffe-central?viewer=/walk/viewer/&world=/worlds/arncliffe-central/world.json`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.state === 'ready');
    check(`${tag} walk: Walk and Go inside are enabled with a local world`, !(await page.locator('#walk').isDisabled()) && !(await page.locator('#inside').isDisabled()));
    await page.click('#walk');
    const frame = page.frameLocator('#walkFrame');
    const f = () => page.frames().find(x => x.url().includes('/walk/viewer/') && x.url().includes('static='));
    await page.waitForFunction(() => document.querySelector('#walkFrame').src.includes('static='));
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) { await page.waitForTimeout(500); ok = await f()?.evaluate(() => window.__siteWalk && window.__siteWalk.isStatic() && window.__siteWalk.released() >= 100).catch(() => false); }
    check(`${tag} walk: the viewer opens the static world and releases all 100 tiles`, !!ok);
    const t0 = Date.now(); let baked = 0;
    while (Date.now() - t0 < 90000 && baked < 9) { await page.waitForTimeout(1000); baked = await f().evaluate(() => window.__siteWalk.tiles().filter(t => t.baked).length).catch(() => 0); }
    check(`${tag} walk: baked tiles load (≥ 9 around the site)`, baked >= 9, `${baked} in ${Math.round((Date.now() - t0) / 1000)} s`);
    const site = await f().evaluate(() => window.__siteWalk.site());
    check(`${tag} walk: the site card centres on planned Building A and says not photographic`, site.focus && site.focus.building_id === 'planned-a' && site.claims.photoreal === false);
    const mode = await f().evaluate(() => window.__siteWalk.pose().mode);
    check(`${tag} walk: "Walk the street" lands in walk mode`, mode === 'walk', mode);
    const hit = await f().evaluate(() => window.__siteWalk.hit(window.__siteWalk.site().focus.east_m, window.__siteWalk.site().focus.north_m));
    check(`${tag} walk: the planned tower is a collider (you cannot walk through it)`, hit && hit.id === 'planned-a', JSON.stringify(hit));
    if (shots) { await page.waitForTimeout(1500); await page.screenshot({ path: `${shots}/walk-street-${tag}.png` }); }
    await page.keyboard.press('Escape');
    await page.click('#inside');
    let inside = false;
    for (let i = 0; i < 120 && !inside; i++) { await page.waitForTimeout(500); inside = await f()?.evaluate(() => window.__siteWalk.interior && window.__siteWalk.interior().inside).catch(() => false); }
    const info = inside ? await f().evaluate(() => window.__siteWalk.interior()) : null;
    check(`${tag} walk: "Go inside" stands you in the level-21 apartment`, inside && info.levels.includes(21) && info.active === 21, info ? `${info.zone && info.zone.name} · ${info.geometry}` : 'not inside');
    if (inside) {
      const before = await f().evaluate(() => window.__siteWalk.pose());
      await frame.locator('#scene').click({ position: { x: 20, y: 20 } }).catch(() => {});
      await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
      const after = await f().evaluate(() => window.__siteWalk.pose());
      const moved = Math.hypot(after.east_m - before.east_m, after.north_m - before.north_m);
      const still = await f().evaluate(() => window.__siteWalk.interior().inside);
      check(`${tag} walk: you can walk inside and stay inside (no falling off level 21)`, still && Math.abs(after.groundZ - before.groundZ) < 0.5, `moved ${moved.toFixed(2)} m`);
      if (shots) { await page.waitForTimeout(1200); await page.screenshot({ path: `${shots}/walk-inside-${tag}.png` }); }
    }
  }
  check(`${tag} zero console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
