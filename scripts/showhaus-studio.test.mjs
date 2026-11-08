// Unit tests: SHOWHAUS Studio core geometry, recorded data integrity and the Worker routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { handleStudio, paymentLink, fallbackUrl } from '../src/studio.js';
import { CLIENT_EVENTS } from '../src/ops/events.js';
const require = createRequire(import.meta.url);
const C = require('../dist/showhaus/studio/lib/studio-core.js');
const S = require('../dist/showhaus/lib/core.js');
const data = JSON.parse(readFileSync(new URL('../dist/showhaus/studio/data/arncliffe-central.json', import.meta.url)));

test('ray entry distance into a square', () => {
  const sq = [[10, -5], [20, -5], [20, 5], [10, 5]];
  assert.equal(C.entryDistance(0, 0, 1, 0, sq), 10);
  assert.equal(C.entryDistance(0, 0, -1, 0, sq), Infinity);
  assert.equal(C.entryDistance(15, 0, 1, 0, sq), 0);
});

test('one extrusion per level plus the roof envelope', () => {
  const f = C.floorFeatures(data).features;
  for (const t of data.towers) {
    const mine = f.filter(x => x.properties.tower === t.id);
    assert.equal(mine.filter(x => x.properties.kind === 'floor').length, t.levels);
    assert.ok(Math.max(...mine.map(x => x.properties.top)) <= t.height_m_est + 1e-9);
  }
});

test('facade points sit outside their own footprint (outward normals)', () => {
  for (const t of data.towers) for (const [a, p] of Object.entries(t.facade_points)) {
    const f = C.frame(data), ring = t.footprint.map(q => f.xy(q[0], q[1])), [x, y] = f.xy(p[0], p[1]);
    assert.equal(C.pointInRing(x, y, ring), false, `${t.id} ${a}`);
  }
});

test('sun: a facade never gets more sun than the sun spends in front of it; winter north beats winter south', () => {
  const ctx = C.context(data), t = data.towers.find(x => x.id === 'A');
  const north = Object.keys(t.aspects).find(a => a.startsWith('N')), south = Object.keys(t.aspects).find(a => a.startsWith('S'));
  const top = t.levels - 1;
  const n = C.facadeSun(data, ctx, 'A', top, north, '2026-06-21', S.solarPosition);
  const s = C.facadeSun(data, ctx, 'A', top, south, '2026-06-21', S.solarPosition);
  assert.ok(n.sunMinutes <= n.frontMinutes && s.sunMinutes <= s.frontMinutes);
  assert.ok(n.sunMinutes > s.sunMinutes, `${n.sunMinutes} vs ${s.sunMinutes}`);
  assert.ok(n.daylightMinutes > 9 * 60 && n.daylightMinutes < 11 * 60);
});

test('views are monotone enough: the top floor sees at least what level 5 sees', () => {
  for (const t of data.towers) {
    const lo = data.views.by_tower[t.id][5], hi = data.views.by_tower[t.id][t.levels - 1];
    for (const a of Object.keys(lo)) for (const id of lo[a]) assert.ok(hi[a].includes(id), `${t.id} ${a} ${id}`);
  }
});

test('every recorded figure has a source line', () => {
  for (const t of data.towers) for (const k of ['max_rl', 'ground_rl', 'levels', 'footprint']) assert.ok(t.sources[k]?.length > 20, `${t.id} ${k}`);
  assert.ok(data.documents.consolidated_consent.startsWith('https://majorprojects.planningportal.nsw.gov.au/'));
});

const env = link => ({ STUDIO_PAYMENT_LINK: link });
test('/pay/studio-pilot redirects to the Stripe Payment Link (observeCheckout logs checkout_started)', async () => {
  const r = await handleStudio(new Request('https://showhaus.app/pay/studio-pilot?src=agency-x'), env('https://buy.stripe.com/aFacN5aRla7jcClaUW1kA00'));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://buy.stripe.com/aFacN5aRla7jcClaUW1kA00');
});
test('/pay/studio-pilot without a link lands on the reserve section', async () => {
  const r = await handleStudio(new Request('https://showhaus.app/pay/studio-pilot'), env(''));
  assert.equal(r.headers.get('location'), 'https://showhaus.app/studio/pilot.html?reserve=1#reserve');
  assert.equal(fallbackUrl(new URL('https://x.workers.dev/pay/studio-pilot')), 'https://x.workers.dev/showhaus/studio/pilot.html?reserve=1#reserve');
  assert.equal(paymentLink({ STUDIO_PAYMENT_LINK: 'https://evil.example/pay' }), null);
});
test('/api/studio-config reports booleans only', async () => {
  const r = await handleStudio(new Request('https://showhaus.app/api/studio-config'), env('https://buy.stripe.com/x'));
  assert.deepEqual(await r.json(), { payment: true, contact: null });
});
test('the one /api/e accepts the studio events', () => {
  for (const e of ['view', 'play', 'floor', 'embed_copy']) assert.ok(CLIENT_EVENTS.has(e), e);
});
test('other paths are left to the asset router', async () => {
  assert.equal(await handleStudio(new Request('https://showhaus.app/studio/'), env('')), null);
});
