// SHOWHAUS Hunt board (src/hunt.js, dist/showhaus/hunt): pasted links → addresses, NSW checks in plain words, and the
// share / comment routes. Runs the real Worker against dist/ and an in-memory D1; NSW services are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { resetForTests } from '../src/ops/store.js';
import { resetClaimsForTests } from '../src/claim.js';
import { resetSuggestForTests } from '../src/suggest.js';
import { parsePasted, summarise, resetHuntForTests, COMMENTS_PER_HOUR, anefFromFile } from '../src/hunt.js';
import { CLIENT_EVENTS } from '../src/ops/events.js';
import { env as localEnv } from './showhaus-local-worker.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 Safari', 'content-type': 'application/json' };
const ctx = () => ({ waitUntil: () => {} });
const calls = [];
function fakeFetch(url) {
  const u = String(url); calls.push(u);
  const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } }));
  if (u.includes('NSW_Geocoded_Addressing_Theme')) {
    const where = new URL(u).searchParams.get('where') || '';
    if (where.includes('NOWHERE')) return json({ features: [] });
    return json({ features: [{ attributes: { address: '12 SMITH STREET BLACKTOWN' }, geometry: { x: 150.9061, y: -33.7713 } }] });
  }
  if (u.includes('/MapServer/2/query') && u.includes('EPI_Primary')) return json({ features: [{ attributes: { SYM_CODE: 'R2', LAY_CLASS: 'Low Density Residential' } }] });
  if (u.includes('/MapServer/229/')) return json({ features: [] });
  if (u.includes('/MapServer/230/')) return json({ features: [{ attributes: { LAY_CLASS: 'Flood Planning Area' } }] });
  if (u.includes('Protection/MapServer/2')) return json({ error: { message: 'down' } });
  if (u.includes('ANEF2039/MapServer/')) return json({ features: u.includes('/MapServer/2/query') ? [{ attributes: { anef: 25 } }] : u.includes('/MapServer/3/query') ? [{ attributes: { anef: 20 } }] : [] });
  if (u.includes('VegStrata')) return json({ features: [{ attributes: { Canopy_pc: 0.176 } }] });
  return Promise.resolve(new Response('nope', { status: 404 }));
}
function makeEnv() {
  resetForTests(); resetClaimsForTests(); resetSuggestForTests(); resetHuntForTests();
  for (const t of ['sh_hunt', 'sh_hunt_comments', 'sh_claim_rate', 'sh_events']) { try { localEnv.OPS_DB._db.exec(`DELETE FROM ${t}`); } catch { /* not created yet */ } }
  localEnv.__fetch = fakeFetch; return localEnv;
}
const get = (env, p) => worker.fetch(new Request('https://showhaus.app' + p, { headers: UA }), env, ctx());
const post = (env, p, b) => worker.fetch(new Request('https://showhaus.app' + p, { method: 'POST', headers: UA, body: JSON.stringify(b) }), env, ctx());

test('paste: a Domain link gives its street, suburb and postcode; realestate.com.au gives the suburb and asks for the street', () => {
  assert.deepEqual(parsePasted('https://www.domain.com.au/12-smith-street-blacktown-nsw-2148-2019123456'), { address: '12 smith street blacktown', postcode: '2148', link: 'domain.com.au' });
  assert.equal(parsePasted('https://www.domain.com.au/4-12-smith-street-blacktown-nsw-2148-2019123456').address, '4/12 smith street blacktown');
  assert.deepEqual(parsePasted('https://www.realestate.com.au/property-house-nsw-mount-druitt-145123456'), { need: 'address', suburb: 'Mount Druitt', link: 'realestate.com.au' });
  assert.equal(parsePasted('https://example.com/x').need, 'address');
  assert.deepEqual(parsePasted('12 Smith St Blacktown'), { address: '12 Smith St Blacktown' });
});

test('summarise: a failed service is unknown, never "none"; hits and misses are plain words', () => {
  const s = summarise({ zoning: { ok: true, rows: [{ SYM_CODE: 'R2', LAY_CLASS: 'Low Density Residential' }] }, bushfire: { ok: true, rows: [] }, flood: { ok: false }, anec: { ok: true, rows: [{ ANEF_CODE: '20-25' }] }, canopy: { ok: true, rows: [{ Canopy_pc: 0.314 }] } });
  assert.equal(s.flood, null);
  assert.equal(s.bushfire.hit, false); assert.match(s.bushfire.text, /Not on bush fire prone land/);
  assert.equal(s.aircraft.hit, true); assert.match(s.aircraft.text, /20-25/);
  assert.equal(s.canopy.pct, 31); assert.equal(s.zoning.code, 'R2');
  assert.equal(summarise({ zoning: { ok: false }, bushfire: { ok: false }, flood: { ok: false }, anec: { ok: false }, canopy: { ok: true, rows: [{ Canopy_pc: 0 }] } }).canopy.pct, 0, 'a real zero is a number, not unknown');
  const clear = summarise({ zoning: { ok: true, rows: [] }, bushfire: { ok: true, rows: [] }, flood: { ok: true, rows: [] }, anec: { ok: true, rows: [] }, canopy: { ok: true, rows: [] } });
  assert.match(clear.aircraft.text, /Mascot\) ANEF could not be checked/, 'Sydney Airport not answering is said, not hidden');
  assert.equal(clear.aircraft.partial, true);
  const both = summarise({ zoning: { ok: true, rows: [] }, bushfire: { ok: true, rows: [] }, flood: { ok: true, rows: [] }, anec: { ok: true, rows: [] }, sydney_anef: { ok: true, rows: [] }, canopy: { ok: true, rows: [] } });
  assert.equal(both.aircraft.hit, false); assert.match(both.aircraft.text, /Outside the Sydney Airport ANEF 2039.*planes can still be heard/);
  const syd = summarise({ zoning: { ok: true, rows: [] }, bushfire: { ok: true, rows: [] }, flood: { ok: true, rows: [] }, anec: { ok: false }, sydney_anef: { ok: true, rows: [{ band: '20–25', anef: 20 }] }, canopy: { ok: true, rows: [] } });
  assert.equal(syd.aircraft.hit, true); assert.match(syd.aircraft.text, /20–25.*conditionally acceptable/);
  const cess = summarise({ zoning: { ok: true, rows: [] }, bushfire: { ok: true, rows: [] }, flood: { ok: true, rows: [] }, anec: { ok: true, rows: [{ ANEF_CODE: '25 - 30', EPI_NAME: 'Cessnock Local Environmental Plan 2011' }] }, sydney_anef: { ok: true, rows: [] }, canopy: { ok: true, rows: [] } });
  assert.match(cess.aircraft.text, /^Cessnock Local Environmental Plan 2011 aircraft noise contour 25 - 30/, 'a regional airport map is named, not called Western Sydney');
  assert.match(clear.flood.text, /some councils are not in it/);
});

test('check: an address resolves through the NSW register and comes back with checks and sources', async () => {
  const env = makeEnv();
  const r = await get(env, '/api/hunt/check?q=' + encodeURIComponent('https://www.domain.com.au/12-smith-street-blacktown-nsw-2148-2019123456'));
  assert.equal(r.status, 200); const d = await r.json();
  assert.equal(d.address, '12 SMITH STREET BLACKTOWN'); assert.equal(d.postcode, '2148'); assert.equal(d.from, 'domain.com.au');
  assert.deepEqual(d.lngLat, [150.9061, -33.7713]);
  assert.equal(d.checks.flood.hit, true); assert.equal(d.checks.bushfire.hit, false); assert.equal(d.checks.aircraft.hit, true); assert.equal(d.checks.aircraft.band, '25–30'); assert.match(d.checks.aircraft.text, /Sydney Airport ANEF 2039.*25–30.*unacceptable/); assert.equal(d.checks.canopy.pct, 18);
  assert.ok(Object.values(d.sources).every(Boolean));
  assert.ok(!calls.some(u => u.includes('domain.com.au')), 'the listing site itself is never fetched');
  const need = await (await get(env, '/api/hunt/check?q=' + encodeURIComponent('https://www.realestate.com.au/property-unit-nsw-parramatta-145123456'))).json();
  assert.equal(need.need, 'address'); assert.equal(need.suburb, 'Parramatta');
  const nope = await (await get(env, '/api/hunt/check?q=' + encodeURIComponent('Blacktown'))).json();
  assert.equal(nope.need, 'address'); assert.match(nope.error, /house or unit number/);
});

test('noise: a map point gets the Sydney Airport ANEF band and its sources; outside NSW is refused', async () => {
  const env = makeEnv();
  const d = await (await get(env, '/api/hunt/noise?ll=151.1655,-33.9165')).json();
  assert.equal(d.aircraft.band, '25–30'); assert.match(d.sources.sydney_anef, /Airservices/); assert.match(d.urls.sydney_anef, /ANEF2039\/MapServer$/);
  assert.equal((await get(env, '/api/hunt/noise?ll=0,0')).status, 400);
});

test('ANEF file: the highest band whose polygon holds the point; a hole is outside; outside every band is a clean miss', () => {
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const fc = { source: { fetched: '2026-11-18T00:00:00+00:00' }, features: [
    { properties: { band: '20-25' }, geometry: { type: 'Polygon', coordinates: [sq(0, 0, 10, 10), sq(8, 8, 9, 9)] } },
    { properties: { band: '30-35' }, geometry: { type: 'MultiPolygon', coordinates: [[sq(2, 2, 4, 4)]] } },
  ] };
  assert.deepEqual(anefFromFile(fc, [3, 3]).rows, [{ band: '30–35', anef: null }]);
  assert.deepEqual(anefFromFile(fc, [6, 6]).rows, [{ band: '20–25', anef: null }]);
  assert.deepEqual(anefFromFile(fc, [8.5, 8.5]).rows, [], 'inside a hole');
  assert.equal(anefFromFile(fc, [20, 20]).ok, true);
});

test('board: share, read, only the sharer can change it, comments land on a real home', async () => {
  const env = makeEnv();
  const items = [{ key: '12 SMITH STREET BLACKTOWN', label: '12 Smith Street, Blacktown NSW', lngLat: [150.9061, -33.7713], postcode: '2148', beds: 3, price: 620, link: 'https://www.domain.com.au/x', note: 'Nice <b>yard</b>', checks: { flood: { hit: true, text: 'x' } } }, { key: '', label: 'junk' }];
  const s = await (await post(env, '/api/hunt/board', { items })).json();
  assert.match(s.id, /^[a-z0-9]{10}$/); assert.ok(s.edit.length >= 20);
  const b = await (await get(env, '/api/hunt/board?id=' + s.id)).json();
  assert.equal(b.items.length, 1, 'an item without a key is dropped'); assert.doesNotMatch(b.items[0].note, /</); assert.equal(b.items[0].beds, 3);
  assert.equal((await post(env, '/api/hunt/board', { id: s.id, edit: 'wrong', items })).status, 403);
  assert.equal((await post(env, '/api/hunt/board', { id: s.id, edit: s.edit, items: [{ ...items[0], note: 'changed' }] })).status, 200);
  assert.equal((await post(env, '/api/hunt/comment', { id: s.id, key: 'NOT ON BOARD', text: 'hi' })).status, 404);
  assert.equal((await post(env, '/api/hunt/comment', { id: s.id, key: items[0].key, name: 'Sam', text: 'Love the backyard' })).status, 200);
  const b2 = await (await get(env, '/api/hunt/board?id=' + s.id)).json();
  assert.equal(b2.items[0].note, 'changed'); assert.deepEqual(b2.comments.map(c => [c.name, c.text]), [['Sam', 'Love the backyard']]);
  assert.equal((await get(env, '/api/hunt/board?id=zzzzzzzzzz')).status, 404);
  assert.ok(COMMENTS_PER_HOUR >= 10);
});

test('events: hunt page events are on the client allowlist', () => {
  for (const e of ['hunt_view', 'hunt_add', 'hunt_remove', 'start_path']) assert.ok(CLIENT_EVENTS.has(e), e);
});
