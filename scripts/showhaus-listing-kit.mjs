// SHOWHAUS listing kit generator: one street address → a hosted property page + 5-second walkthrough GIF.
//
//   node scripts/showhaus-listing-kit.mjs "40 Melrose Parade, Clovelly NSW 2031" --slug 40-melrose-pde-clovelly
//   flags: --no-media (data only) · --media-only (re-record from the existing JSON) · --listing <agency URL>
//
// Needs (not committed): npm i --no-save @mapbox/vector-tile@2.0.3 pbf@4.0.1 playwright@1.56.1, and ffmpeg on PATH.
// Writes dist/showhaus/p/<slug>.json and dist/showhaus/p/<slug>/{walkthrough.gif,walkthrough.mp4,poster.png,scene.png}.
// Every value comes from a public source fetched here, with its URL and fetch date; unknown stays unknown.
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const C = require('../dist/showhaus/lib/core.js');
const K = require('../dist/showhaus/lib/kit.js');
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const OUT = join(DIST, 'showhaus/p');
const UA = 'SHOWHAUS-listing-kit/0.1 (+https://showhaus.app)'; // polite, identifies the tool, no personal data

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const address = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--slug', '--listing'].includes(args[i - 1])));
const slug = opt('--slug');
if (!address || !slug || !/^[a-z0-9-]{3,80}$/.test(slug)) {
  console.error('usage: node scripts/showhaus-listing-kit.mjs "<street address>" --slug <a-z0-9-> [--listing URL] [--no-media|--media-only]');
  process.exit(2);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const nowIso = () => new Date().toISOString();

async function getJSON(url, init = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 90)}`);
      return await r.json();
    } catch (e) { if (i >= tries) throw e; await sleep(1500 * i); }
  }
}

// ---------- address ----------
function parseAddress(a) {
  const m = /^\s*(?:(\w+)\s*\/\s*)?([\d]+[A-Za-z]?(?:-\d+[A-Za-z]?)?)\s+(.+?),\s*([A-Za-z' ]+?)\s+NSW\s*(\d{4})?\s*$/i.exec(a);
  if (!m) throw new Error('address must look like "12 Example Street, Suburb NSW 2000"');
  return { unit: m[1] || null, number: m[2], street: m[3].trim(), suburb: m[4].trim(), postcode: m[5] || null };
}
const ABBR = { st: 'STREET', rd: 'ROAD', ave: 'AVENUE', av: 'AVENUE', pde: 'PARADE', cres: 'CRESCENT', pl: 'PLACE', dr: 'DRIVE', ln: 'LANE', tce: 'TERRACE', hwy: 'HIGHWAY', cct: 'CIRCUIT', cl: 'CLOSE' };
const fullStreet = s => s.split(/\s+/).map((w, i, a) => (i === a.length - 1 && ABBR[w.toLowerCase()]) || w.toUpperCase()).join(' ');

async function geocode(a) {
  const p = parseAddress(a);
  const out = { input: a, parsed: p, fetched: nowIso() };
  // 1) Nominatim (OSM), restricted to Australia, one request, polite UA.
  const q = `${p.number} ${p.street}, ${p.suburb} NSW ${p.postcode || ''}`.trim();
  const nomUrl = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'au', addressdetails: '1', limit: '1' })}`;
  try {
    const [n] = await getJSON(nomUrl);
    if (n) out.nominatim = { lat: +n.lat, lng: +n.lon, display_name: n.display_name, house_level: !!n.address?.house_number, osm: `${n.osm_type}/${n.osm_id}`, url: nomUrl };
  } catch (e) { out.nominatim = { error: e.message, url: nomUrl }; }
  await sleep(1100);
  // 2) NSW Geocoded Addressing Theme (the state's own address points), exact string match, then the range start.
  const gatBase = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/FeatureServer/1/query';
  const st = fullStreet(p.street), sub = p.suburb.toUpperCase();
  const tries = [p.unit && `${p.unit}/${p.number} ${st} ${sub}`, `${p.number} ${st} ${sub}`, p.number.includes('-') && `${p.number.split('-')[0]} ${st} ${sub}`].filter(Boolean);
  for (const t of tries) {
    const url = `${gatBase}?${new URLSearchParams({ where: `address='${t.replace(/'/g, "''")}'`, outFields: 'address,addresspointtype', outSR: '4326', f: 'json' })}`;
    const d = await getJSON(url).catch(() => null);
    const f = d?.features?.[0];
    if (f) { out.gat = { address: f.attributes.address, lat: f.geometry.y, lng: f.geometry.x, url }; break; }
  }
  const nom = out.nominatim?.house_level ? out.nominatim : null;
  if (out.gat && nom) out.offset_m = Math.round(C.metres(out.gat, nom));
  const pick = out.gat || nom;
  if (!pick) throw new Error(`could not geocode "${a}" to a house-level point (Nominatim: ${out.nominatim?.display_name || out.nominatim?.error || 'none'})`);
  out.method = out.gat ? 'NSW address point (GAT)' + (nom ? `; Nominatim agrees within ${out.offset_m} m` : '; Nominatim had no house-level match') : 'Nominatim house-level match';
  out.lat = +pick.lat.toFixed(7); out.lng = +pick.lng.toFixed(7);
  return out;
}

// ---------- lot (NSW cadastre) ----------
async function lots(pt) {
  const url = `https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Land_Parcel_Property_Theme/FeatureServer/8/query?${new URLSearchParams({ geometry: `${pt.lng},${pt.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'lotnumber,sectionnumber,planlabel', returnGeometry: 'true', outSR: '4326', f: 'json' })}`;
  const d = await getJSON(url).catch(e => ({ error: e.message }));
  const feats = (d.features || []).map(f => ({ label: [f.attributes.lotnumber && `Lot ${f.attributes.lotnumber}`, f.attributes.sectionnumber && `Sec ${f.attributes.sectionnumber}`, f.attributes.planlabel].filter(Boolean).join(' '), rings: f.geometry.rings.map(r => r.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)])) }));
  return { source: 'NSW Spatial Services cadastre (Land Parcel & Property Theme, Lot layer)', licence: 'CC BY 4.0', url, fetched: nowIso(), error: d.error || null, lots: feats };
}

// ---------- buildings (raw OSM tags, so mapped and unmapped heights can be told apart) ----------
function heightOf(tags) {
  const num = v => { const m = /^\s*(\d+(?:\.\d+)?)\s*(m|metres|meters)?\s*$/i.exec(String(v ?? '')); return m ? +m[1] : null; };
  const h = num(tags.height);
  const minH = num(tags.min_height) ?? (num(tags['building:min_level']) != null ? num(tags['building:min_level']) * 3 : 0);
  if (h != null && h > 0) return { h, src: 'height', min: minH };
  const lv = num(tags['building:levels']);
  if (lv != null && lv > 0) return { h: +(lv * 3 + (num(tags['roof:levels']) || 0) * 1.5).toFixed(1), src: 'levels', min: minH };
  const small = /^(garage|garages|shed|carport|roof|hut|kiosk)$/.test(tags.building);
  return { h: small ? 3 : 6, src: 'est', min: minH };
}
async function buildings(pt, radius = 260) {
  const dLat = radius / 111320, dLng = radius / (111320 * Math.cos(pt.lat * Math.PI / 180));
  const bbox = [pt.lng - dLng, pt.lat - dLat, pt.lng + dLng, pt.lat + dLat].map(v => v.toFixed(6)).join(',');
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`;
  const d = await getJSON(url);
  const nodes = new Map();
  for (const e of d.elements) if (e.type === 'node') nodes.set(e.id, [+e.lon.toFixed(7), +e.lat.toFixed(7)]);
  const ways = new Map(d.elements.filter(e => e.type === 'way').map(w => [w.id, w]));
  const features = [];
  const push = (id, tags, nodeIds) => {
    const ring = nodeIds.map(n => nodes.get(n)).filter(Boolean);
    if (ring.length < 4 || ring.length > 180) return;
    const c = ring[0];
    if (C.metres(pt, { lng: c[0], lat: c[1] }) > radius) return;
    const { h, src, min } = heightOf(tags);
    features.push({ id, type: tags.building, h, src, min, ring });
  };
  for (const w of ways.values()) if (w.tags?.building && w.tags.building !== 'no') push(`w${w.id}`, w.tags, w.nodes);
  // Multipolygon buildings: each closed outer way, with the relation's tags.
  for (const r of d.elements.filter(e => e.type === 'relation' && e.tags?.building)) for (const m of r.members.filter(m => m.type === 'way' && m.role === 'outer')) { const w = ways.get(m.ref); if (w && w.nodes[0] === w.nodes.at(-1)) push(`r${r.id}:${m.ref}`, r.tags, w.nodes); }
  const counts = { total: features.length, height: features.filter(f => f.src === 'height').length, levels: features.filter(f => f.src === 'levels').length, estimated: features.filter(f => f.src === 'est').length };
  return { source: 'OpenStreetMap (API 0.6 map call): building footprints; height or building:levels tags', licence: 'ODbL 1.0, © OpenStreetMap contributors', url, fetched: nowIso(), radius_m: radius, estimate_rule: 'no height or building:levels tag → 6 m (garage/shed/carport 3 m), shown as estimated and never used for a sun-hours claim; levels × 3 m', counts, features };
}

// ---------- roads (OSM via OpenFreeMap vector tiles: same source the SHOWHAUS map draws) ----------
async function roads(pt) {
  const { VectorTile } = await import('@mapbox/vector-tile');
  const { default: Pbf } = await import('pbf');
  const tj = await getJSON('https://tiles.openfreemap.org/planet');
  const tmpl = tj.tiles[0], z = 14;
  const tx = Math.floor((pt.lng + 180) / 360 * 2 ** z);
  const ty = Math.floor((1 - Math.log(Math.tan(pt.lat * Math.PI / 180) + 1 / Math.cos(pt.lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
  const lines = [], names = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const x = tx + dx, y = ty + dy;
    const r = await fetch(tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error('tile HTTP ' + r.status);
    const t = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
    const take = (layer, fn) => { const L = t.layers[layer]; if (!L) return; for (let i = 0; i < L.length; i++) { const f = L.feature(i).toGeoJSON(x, y, z); fn(f); } };
    const asLines = g => g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    take('transportation', f => { if (!(f.properties.class in RANK)) return; for (const l of asLines(f.geometry)) lines.push({ cls: f.properties.class, pts: l.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]) }); });
    take('transportation_name', f => { if (!f.properties.name || !(f.properties.class in RANK)) return; for (const l of asLines(f.geometry)) names.push({ cls: f.properties.class, name: f.properties.name, pts: l }); });
  }
  // Keep what the page and the judge need: every road within 200 m, main roads within 2.5 km.
  const near = l => { const r = C.nearestOnLines(pt, [l.pts]); return r ? r.distance : Infinity; };
  const kept = lines.filter(l => near(l) <= 200 || (K.MAIN.has(l.cls) && near(l) <= 2500));
  for (const l of kept) { // name a segment from the nearest name line of the same class
    const mid = l.pts[l.pts.length >> 1]; let best = null;
    for (const n of names) if (n.cls === l.cls) { const r = C.nearestOnLines({ lng: mid[0], lat: mid[1] }, [n.pts]); if (r && r.distance < 25 && (!best || r.distance < best.d)) best = { d: r.distance, name: n.name }; }
    if (best) l.name = best.name;
  }
  const nearest = K.nearestRoads(pt, kept);
  const round = h => h && { distance_m: Math.round(h.distance), cls: h.cls, name: h.name, at: h.at.map(v => +v.toFixed(6)) };
  return { source: 'OpenStreetMap road centrelines via OpenFreeMap vector tiles (z14)', licence: 'ODbL 1.0, © OpenStreetMap contributors', tiles: tmpl, fetched: nowIso(), main_rule: 'main road = OSM class motorway, trunk or primary', nearest: { any: round(nearest.any), main: round(nearest.main) }, lines: kept };
}
const RANK = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, minor: 1, service: 0 };

// ---------- NSW services (point queries) ----------
async function arcgis(name, url, fields, pt) {
  const q = `${url}?${new URLSearchParams({ where: '1=1', geometry: `${pt.lng},${pt.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: fields, returnGeometry: 'false', f: 'json' })}`;
  try {
    const d = await getJSON(q);
    if (d.error) throw new Error(d.error.message || 'service error');
    return { name, ok: true, url: q, fetched: nowIso(), rows: (d.features || []).map(f => f.attributes) };
  } catch (e) { return { name, ok: false, url: q, fetched: nowIso(), error: e.message, rows: [] }; }
}
const SVC = {
  canopy: ['NSW Government 2024–25 urban canopy H3 grid (GSR_2024_VegStrata_H3Z11)', 'https://mapprod2.environment.nsw.gov.au/arcgis/rest/services/UHGC/GSR_2024_VegStrata_H3Z11/MapServer/0/query', 'h3_index,Canopy_pc,All_veg_pc,Suburb'],
  zoning: ['NSW Planning Portal — Land Zoning (EPI Primary Planning Layers)', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer/2/query', 'SYM_CODE,LAY_CLASS,EPI_NAME'],
  bushfire: ['NSW Planning Portal — Bush Fire Prone Land (RFS certified)', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/229/query', 'd_Category,Category'],
  flood: ['NSW Planning Portal — Flood Planning (state layer)', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/230/query', 'LAY_CLASS,EPI_NAME,LGA_NAME'],
  anec: ['NSW Planning — Airport noise (Western Sydney Airport ANEC, SEPP Precincts—Western Parkland City)', 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Protection/MapServer/2/query', 'ANEF_CODE,EPI_NAME'],
};

async function buildData() {
  console.log(`· geocoding ${address}`);
  const g = await geocode(address);
  const pt = { lat: g.lat, lng: g.lng };
  console.log(`  ${g.method} → ${pt.lat}, ${pt.lng}`);
  const [lot, b, road, ...svc] = await Promise.all([lots(pt), buildings(pt), roads(pt), ...Object.entries(SVC).map(([k, [n, u, f]]) => arcgis(n, u, f, pt).then(r => [k, r]))]);
  const s = Object.fromEntries(svc);
  const R = JSON.parse(await readFile(join(DIST, 'showhaus/data/rents.json'), 'utf8'));
  const postcode = g.parsed.postcode || null;
  const places = JSON.parse(await readFile(join(DIST, 'showhaus/data/places.json'), 'utf8'));
  const suburbsInPc = places.suburbs.filter(x => String(x[1]) === String(postcode)).map(x => x[0]);
  const rent = R && postcode ? K.rentSummary(R, postcode) : null;
  const ground = K.openGroundPoints(lot.lots, b.features, pt);
  const kit = {
    schema: 1, slug, address, kit_date: today, generated_at: nowIso(),
    generator: 'scripts/showhaus-listing-kit.mjs',
    listing_url: opt('--listing'),
    geocode: g, lot, buildings: b, roads: road, ground,
    canopy: s.canopy, planning: { zoning: s.zoning, bushfire: s.bushfire, flood: s.flood },
    aircraft: { wsa_anec: s.anec, sydney_anef: { ok: false, status: 'not connected', why: 'Sydney Airport ANEF 2039 has no verified GIS service (published as Master Plan PDF figures only); shown as unknown, never as quiet.' } },
    rent: rent && { ...rent, suburbs: suburbsInPc, source: R.sources.map(x => `${x.name} (${x.licence})`).join(' · '), built: R.generatedAt },
  };
  const sunKit = K.groundSun(kit, today), sunWinter = K.groundSun(kit, today.slice(0, 4) + '-06-21');
  kit.sun_at_kit_date = { [today]: sunKit, winter: sunWinter };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${slug}.json`), JSON.stringify(kit));
  const sz = (await stat(join(OUT, `${slug}.json`))).size;
  console.log(`  lot: ${lot.lots.map(l => l.label).join(', ') || 'none (' + (lot.error || 'no parcel at point') + ')'}; buildings ${JSON.stringify(b.counts)}; ground points ${ground.points.length} (${ground.basis})`);
  console.log(`  road: any ${road.nearest.any?.distance_m} m (${road.nearest.any?.cls} ${road.nearest.any?.name || ''}); main ${road.nearest.main?.distance_m ?? '>2.5 km'} m (${road.nearest.main?.name || ''})`);
  console.log(`  sun ${today}: ${sunKit.known ? K.hm(sunKit.minutes) : 'unknown — ' + sunKit.why}; 21 Jun: ${sunWinter.known ? K.hm(sunWinter.minutes) : 'unknown'}`);
  console.log(`  canopy ${s.canopy.rows[0]?.Canopy_pc ?? '—'}; zoning ${s.zoning.rows[0]?.SYM_CODE ?? '—'}; rent ${rent?.all.median} (n=${rent?.all.n}); json ${(sz / 1024).toFixed(0)} KB`);
  return kit;
}

// ---------- media (headless Chromium records the real page) ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
function serve() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/e') { res.writeHead(204); return res.end(); }
    try {
      let p = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (p.endsWith('/')) p += 'index.html';
      const body = await readFile(join(DIST, p));
      res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  }).listen(0);
  return server;
}
async function media() {
  const { chromium } = await import('playwright');
  const server = serve();
  const base = `http://127.0.0.1:${server.address().port}/showhaus/p/`;
  const dir = join(OUT, slug);
  await mkdir(dir, { recursive: true });
  const frames = join(tmpdir(), `showhaus-frames-${slug}`);
  await rm(frames, { recursive: true, force: true }); await mkdir(frames, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    // 1) Walkthrough: 100 frames over 5 s (20 fps) — camera orbit + sunrise→sunset sweep on the kit date.
    const W = 640, H = 400;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.error('  page error:', e.message));
    await page.goto(`${base}?a=${slug}&rec=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__kit?.ready === true, null, { timeout: 90000 });
    const N = 100;
    for (let i = 0; i < N; i++) {
      await page.evaluate(t => window.__kit.frame(t), i / (N - 1));
      await page.waitForFunction(() => window.__kit.idle(), null, { timeout: 60000 });
      await page.screenshot({ path: join(frames, `f${String(i).padStart(3, '0')}.png`) });
    }
    await page.close();
    const ff = a => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
    ff(['-framerate', '20', '-i', join(frames, 'f%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', join(dir, 'walkthrough.mp4')]);
    // GIF: every other frame → 50 frames × 10 cs = exactly 5.00 s.
    const gif = join(dir, 'walkthrough.gif');
    for (const [w, colors] of [[640, 128], [560, 96], [520, 64], [480, 48]]) {
      ff(['-framerate', '20', '-i', join(frames, 'f%03d.png'), '-filter_complex', `[0:v]select='not(mod(n\\,2))',setpts=N/(10*TB),scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-r', '10', '-loop', '0', gif]);
      const size = (await stat(gif)).size;
      console.log(`  walkthrough.gif ${w}px/${colors} colours: ${(size / 1048576).toFixed(2)} MB`);
      if (size <= 1.8 * 1048576) break;
    }
    ff(['-i', join(frames, 'f050.png'), '-frames:v', '1', join(dir, 'poster.png')]);
    // 2) Scene: the full page at desktop size, 21 June 3 pm (the winter afternoon shadow on the lot).
    const scene = await browser.newPage({ viewport: { width: 1200, height: 750 }, deviceScaleFactor: 1 });
    await scene.goto(`${base}?a=${slug}&scene=winter-15`, { waitUntil: 'load' });
    await scene.waitForFunction(() => window.__kit?.ready === true, null, { timeout: 90000 });
    await scene.waitForFunction(() => window.__kit.idle(), null, { timeout: 60000 });
    await scene.waitForTimeout(500);
    await scene.screenshot({ path: join(dir, 'scene.png') });
    await scene.close();
  } finally { await browser.close(); server.close(); }
  for (const f of ['walkthrough.gif', 'walkthrough.mp4', 'poster.png', 'scene.png']) console.log(`  ${f}: ${((await stat(join(dir, f))).size / 1024).toFixed(0)} KB`);
}

if (!flag('--media-only')) await buildData();
if (!flag('--no-media')) await media();
console.log(`done: https://showhaus.app/p/?a=${slug}&src=agent-${slug}`);
