// SHOWHAUS address pages (src/place.js): slug ⇄ register address, the rendered page, paste → page, sitemaps.
// Runs the real Worker against dist/ with the NSW services faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { slugOf, candidatesOf, postcodeOf, rentRows, tiles, resetPlaceForTests } from '../src/place.js';
import { env as localEnv } from './showhaus-local-worker.mjs';

const ctx = () => ({ waitUntil: () => {} });
const REG = { '12 SMITH STREET BLACKTOWN': [150.9061, -33.7713], '4/17 FLOOD STREET CLOVELLY': [151.2627, -33.9116], '1 BOTANY ROAD MASCOT': [151.1872, -33.9230] };
const calls = [];
function fakeFetch(url) {
  const u = String(url); calls.push(u);
  const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } }));
  if (u.includes('NSW_Geocoded_Addressing_Theme')) {
    const sp = new URL(u).searchParams, where = sp.get('where') || '';
    if (sp.get('geometryType') === 'esriGeometryEnvelope') return json({ features: Object.keys(REG).map(a => ({ attributes: { address: a } })).concat([{ attributes: { address: 'LOT 5 NOWHERE' } }]) });
    const eq = where.match(/^address = '(.*)'$/), like = where.match(/^address LIKE '(.*)%'$/);
    const rows = Object.entries(REG).filter(([a]) => eq ? a === eq[1].replace(/''/g, "'") : like ? a.startsWith(like[1]) : false);
    return json({ features: rows.map(([a, [x, y]]) => ({ attributes: { address: a }, geometry: { x, y } })) });
  }
  if (u.includes('EPI_Primary')) return json({ features: [{ attributes: { SYM_CODE: 'R2', LAY_CLASS: 'Low Density Residential' } }] });
  if (u.includes('/MapServer/229/')) return json({ features: [] });
  if (u.includes('/MapServer/230/')) return json({ features: [] });
  if (u.includes('Protection/MapServer/2')) return json({ features: [] });
  if (u.includes('ANEF2039/MapServer/')) { const mascot = u.includes('151.1872'); return json({ features: mascot && u.includes('/MapServer/1/query') ? [{ attributes: { anef: 30 } }] : [] }); }
  if (u.includes('VegStrata')) return json({ error: { message: 'down' } });
  return Promise.resolve(new Response('nope', { status: 404 }));
}
const env = () => { resetPlaceForTests(); localEnv.__fetch = fakeFetch; return localEnv; };
const get = (e, p) => worker.fetch(new Request('https://showhaus.app' + p, { headers: { 'user-agent': 'Mozilla/5.0' } }), e, ctx());

test('slugs: register address ⇄ slug, a unit and a range both tried', () => {
  assert.equal(slugOf('4/17 FLOOD STREET CLOVELLY'), '4-17-flood-street-clovelly');
  assert.equal(slugOf("12 O'CONNELL STREET NEWTOWN"), '12-oconnell-street-newtown');
  assert.deepEqual(candidatesOf('4-17-flood-street-clovelly'), ['4/17 FLOOD STREET CLOVELLY', '4-17 FLOOD STREET CLOVELLY']);
  assert.deepEqual(candidatesOf('walk'), []);
});

test('page: a register address gets its checks, rent and links; unknown is said as unknown', async () => {
  const e = env();
  const r = await get(e, '/p/1-botany-road-mascot');
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<title>1 Botany Road, Mascot NSW 2020 — flood, bush fire, aircraft noise, zoning, rent · SHOWHAUS<\/title>/);
  assert.match(h, /<link rel="canonical" href="https:\/\/showhaus.app\/p\/1-botany-road-mascot">/);
  assert.match(h, /data-k="aircraft" data-state="flag"><b>Aircraft noise<\/b><span>Sydney Airport ANEF 2039 noise contour 30–35/);
  assert.match(h, /data-k="flood" data-state="clear"/);
  assert.match(h, /data-k="canopy" data-state="unknown"/, 'a service that failed is unknown, not zero');
  assert.match(h, /href="\/hunt\/\?q=1%20Botany%20Road%2C%20Mascot%20NSW&amp;src=place"|href="\/hunt\/\?q=1%20Botany%20Road%2C%20Mascot%20NSW&src=place"/);
  assert.match(h, /Ask for a 3D walk of this home/);
  assert.match(h, /"@type":"Place"/);
  assert.doesNotMatch(h, /noindex/);
  assert.match(h, /data-k="all" data-n="\d+"><th>All new leases<\/th><td><b>\$[\d,]+\/wk<\/b>/, 'Mascot 2020 has bond records');
});

test('page: non-canonical slug redirects, kit slugs go to the kit, unknown address is a 404 with real neighbours only', async () => {
  const e = env();
  const red = await get(e, '/p/12-smith-st-blacktown');
  assert.equal(red.status, 301); assert.equal(red.headers.get('location'), 'https://showhaus.app/p/12-smith-street-blacktown');
  const kit = await get(e, '/p/14-ethel-st-randwick?src=x');
  assert.equal(kit.status, 302); assert.equal(kit.headers.get('location'), 'https://showhaus.app/p/?a=14-ethel-st-randwick&src=x');
  const nf = await get(e, '/p/99-smith-street-blacktown');
  assert.equal(nf.status, 404); const t = await nf.text();
  assert.match(t, /noindex/); assert.doesNotMatch(t, /99 Smith Street, Blacktown NSW 2148 —/);
  const unit = await get(e, '/p/4-17-flood-street-clovelly');
  assert.equal(unit.status, 200); assert.match(await unit.text(), /<h1>4\/17 Flood Street<span>Clovelly NSW 2031<\/span>/);
  assert.equal((await get(e, '/p/kit-page.js')).headers.get('content-type')?.includes('javascript') || (await get(e, '/p/kit-page.js')).status === 200, true, 'static files under /p/ still served');
});

test('paste: an address or a Domain link lands on the address page; a realestate.com.au link asks for the street', async () => {
  const e = env();
  const a = await get(e, '/p/go?q=' + encodeURIComponent('12 Smith St, Blacktown NSW 2148'));
  assert.equal(a.status, 302); assert.equal(a.headers.get('location'), 'https://showhaus.app/p/12-smith-street-blacktown?src=paste');
  const d = await get(e, '/p/go?q=' + encodeURIComponent('https://www.domain.com.au/12-smith-street-blacktown-nsw-2148-2019123456'));
  assert.equal(d.headers.get('location'), 'https://showhaus.app/p/12-smith-street-blacktown?src=paste-domaincomau');
  const rea = await get(e, '/p/go?q=' + encodeURIComponent('https://www.realestate.com.au/property-house-nsw-blacktown-145123456'));
  assert.equal(rea.status, 200); assert.match(await rea.text(), /only gives the suburb \(Blacktown\)/);
  assert.ok(!calls.some(u => /domain\.com\.au|realestate\.com\.au/.test(u)), 'listing sites are never fetched');
});

test('sitemaps: index of Sydney tiles, a tile lists register addresses only, robots points at it', async () => {
  const e = env();
  const idx = await (await get(e, '/sitemap.xml')).text();
  assert.ok(tiles().length > 1000 && tiles().length < 50000);
  assert.match(idx, /<loc>https:\/\/showhaus.app\/sitemaps\/15118_3392.xml<\/loc>/);
  const t = await (await get(e, '/sitemaps/15118_3392.xml')).text();
  assert.match(t, /<loc>https:\/\/showhaus.app\/p\/1-botany-road-mascot<\/loc>/);
  assert.doesNotMatch(t, /lot-5-nowhere/, 'only numbered street addresses');
  assert.equal((await get(e, '/sitemaps/1_1.xml')).status, 404);
  assert.match(await (await get(e, '/robots.txt')).text(), /Sitemap: https:\/\/showhaus.app\/sitemap.xml/);
});

test('rent rows: fewer than 10 leases never shows a median', () => {
  const rows = rentRows({ all: [120, 700, 600, 800], b4: [7, 1500, 1400, 1600] });
  assert.equal(rows[0].median, 700); assert.equal(rows.find(r => r.key === 'b4').median, null); assert.equal(rows.find(r => r.key === 'houses').n, 0);
  assert.deepEqual(postcodeOf({ suburbs: [['Mascot', '2020', -33.92, 151.19], ['Mascot', '9999', -30, 150]] }, '1 Botany Road, Mascot NSW', [151.187, -33.923]), { postcode: '2020', suburb: 'Mascot' });
});
