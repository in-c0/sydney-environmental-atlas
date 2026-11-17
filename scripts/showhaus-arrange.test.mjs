// SHOWHAUS arrange (dist/showhaus/arrange, src/arrange.js): the plan geometry the page and the server share
// (dist/showhaus/walk/plan-core.js), the published plan copies, and the no-sign-up share route on the real Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { resetForTests } from '../src/ops/store.js';
import { resetClaimsForTests } from '../src/claim.js';
import { resetArrangeForTests, SHARES_PER_HOUR } from '../src/arrange.js';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../src/ops/events.js';
import { env as localEnv } from './showhaus-local-worker.mjs';
import { PUBLISH, publishable } from './showhaus-arrange-plans.mjs';
import { CATALOGUE, PALETTE, fromPlanItem, rectOf, rectInRoom, snap, clearances, clashes, roomPlan, cleanLayout, wallBoxes } from '../dist/showhaus/walk/plan-core.js';

const ROOT = new URL('../', import.meta.url);
const plan = slug => JSON.parse(readFileSync(new URL(`dist/showhaus/arrange/plans/${slug}.json`, ROOT), 'utf8'));
const source = slug => JSON.parse(readFileSync(new URL(`showhaus/walk-pipeline/plans/${slug}.plan.json`, ROOT), 'utf8'));

test('published plans are exactly the pipeline plans (run scripts/showhaus-arrange-plans.mjs after editing one)', () => {
  const idx = JSON.parse(readFileSync(new URL('dist/showhaus/arrange/plans/index.json', ROOT), 'utf8'));
  assert.deepEqual(idx.items.map(i => i.slug), PUBLISH);
  for (const s of PUBLISH) assert.deepEqual(plan(s), publishable(source(s)), s);
  for (const i of idx.items.filter(i => i.slug.startsWith('fixture-'))) assert.match(i.name, /invented/, 'a fixture says it is invented');
});

test('every item in every published plan is a known type and stands inside the room', () => {
  for (const s of PUBLISH) {
    const p = plan(s);
    for (const it of (p.items || []).map(fromPlanItem).filter(Boolean)) assert.ok(rectInRoom(p, rectOf(it, false)), `${s}: ${it.t} at ${it.x},${it.y}`);
  }
  for (const [, t] of PALETTE) assert.ok(CATALOGUE[t] && !CATALOGUE[t].fixed, t);
});

test('walls: furniture cannot sit through an outer wall, a notch of an L-shaped room, or an internal wall', () => {
  const studio = plan('fixture-studio'); // L: [[0,0],[7,0],[7,4],[4,4],[4,7],[0,7]]
  const sofa = { id: 'a', t: 'sofa', x: 2, y: 2, r: 0, w: 2.3, d: 0.95 };
  assert.ok(rectInRoom(studio, rectOf(sofa, false)));
  assert.ok(!rectInRoom(studio, rectOf({ ...sofa, x: 6.5 }, false)), 'through the east wall');
  assert.ok(!rectInRoom(studio, rectOf({ ...sofa, x: 4.5, y: 4.2 }, false)), 'across the notch');
  assert.ok(rectInRoom(studio, rectOf({ ...sofa, x: 2.5, y: 4.2 }, false)), 'west of the notch is fine');
  const apt = plan('fixture-apartment');
  assert.equal(wallBoxes(apt).length, 6);
  assert.ok(!rectInRoom(apt, rectOf({ ...sofa, x: 1.5, y: 4.8 }, false)), 'through the bedroom wall');
  assert.ok(rectInRoom(apt, rectOf({ ...sofa, x: 1.5, y: 4.2 }, false)), 'just in front of it');
  assert.ok(rectInRoom(apt, rectOf({ id: 'o', t: 'outdoor_table', x: 3.5, y: -0.95, r: 0, w: 1.4, d: 0.9 }, false)), 'the balcony counts');
});

test('snap: 5 cm grid, then flush to the nearest wall face (outer or internal); clearances measure to walls and furniture', () => {
  const room = roomPlan(3.6, 4.2);
  const bed = snap(room, { id: 'b', t: 'bed', x: 1.81, y: 3.07, r: 0, w: 1.53, d: 2.12 });
  assert.equal(bed.y, 4.2 - 1.06, 'pulled flush to the north wall'); assert.equal(bed.x, 1.8);
  const apt = plan('fixture-apartment');
  const ward = snap(apt, { id: 'w', t: 'wardrobe', x: 1.5, y: 5.2, r: 0, w: 1.8, d: 0.6 });
  assert.equal(ward.y, 4.845 + 0.3, 'flush to the bedroom side of the internal wall (90 mm wall)');
  const desk = { id: 'd', t: 'desk', x: 0.7, y: 1.0, r: 0, w: 1.4, d: 0.7 };
  const g = clearances(room, [desk, { id: 'x', t: 'drawers', x: 2.6, y: 1.0, r: 0, w: 1.2, d: 0.5 }], desk);
  assert.equal(g.w, 0); assert.equal(g.e, 0.6); assert.equal(g.s, 0.65); assert.equal(g.n, 2.85);
  assert.deepEqual([...clashes([desk, { ...desk, id: 'y', x: 1.2 }, { id: 'r', t: 'rug', x: 1, y: 1, r: 0, w: 2, d: 2 }])].sort(), ['d', 'y'], 'rugs never clash');
  const dining = rectOf({ id: 't', t: 'dining', x: 0, y: 0, r: 90, w: 1.6, d: 0.9 });
  assert.deepEqual(dining, [-0.9, -0.8, 0.9, 0.8], 'a turned table carries its chairs on the long sides');
});

test('cleanLayout: bounded, plain text, built-in kitchen pieces never come from a client', () => {
  const L = cleanLayout({ plan: 'buildtec-erina', title: '<b>Our</b> place', items: [
    { t: 'sofa', x: 1, y: 2, r: 45, w: 2.3, d: 0.95, label: '<script>x</script>' }, { t: 'kitchen_run', x: 1, y: 1, w: 3, d: 0.6 }, { t: 'nope', x: 1, y: 1, w: 1, d: 1 },
    { t: 'box', x: 1, y: 1, w: 99, d: 0.5 }] });
  assert.equal(L.items.length, 2); assert.equal(L.items[0].r, 0); assert.equal(L.items[0].label, 'script x/script'.replace(/ /, '')); assert.equal(L.items[1].w, 6);
  assert.equal(L.title, 'bOur/b place');
  assert.equal(cleanLayout({ plan: '../x', items: [] }), null); assert.equal(cleanLayout({ room: { w: 'x', d: 3 } }), null);
  assert.equal(cleanLayout({ items: Array.from({ length: 200 }, () => ({ t: 'plant', x: 1, y: 1, w: 0.4, d: 0.4 })), room: { w: 3, d: 3 } }).items.length, 80);
});

function makeEnv() {
  resetForTests(); resetClaimsForTests(); resetArrangeForTests();
  for (const t of ['sh_arrange', 'sh_claim_rate', 'sh_events']) { try { localEnv.OPS_DB._db.exec(`DELETE FROM ${t}`); } catch { /* not created yet */ } }
  return localEnv;
}
const H = { 'user-agent': 'Mozilla/5.0 Safari', 'content-type': 'application/json' };
const req = (env, path, body, ip = '1.2.3.4') => worker.fetch(new Request('https://showhaus.app' + path, body ? { method: 'POST', headers: { ...H, 'cf-connecting-ip': ip }, body: JSON.stringify(body) } : { headers: H }), env, { waitUntil: () => {} });

test('share: anyone with ?b= reads the layout; only the #e= holder changes it; shares are rate-limited', async () => {
  const env = makeEnv();
  const layout = { room: { w: 3, d: 3.2 }, title: 'Arjun’s room', items: [{ t: 'bed', x: 1, y: 1.1, r: 0, w: 1.44, d: 2 }] };
  const r = await req(env, '/api/arrange/board', { layout }); assert.equal(r.status, 200);
  const { id, edit } = await r.json(); assert.match(id, /^[a-z0-9]{10}$/); assert.match(edit, /^[a-z0-9]{24}$/);
  const got = await (await req(env, '/api/arrange/board?id=' + id)).json();
  assert.equal(got.layout.items[0].t, 'bed'); assert.equal(got.layout.title, 'Arjun’s room');
  assert.equal((await req(env, '/api/arrange/board', { id, edit: 'x'.repeat(24), layout })).status, 403);
  const upd = await req(env, '/api/arrange/board', { id, edit, layout: { ...layout, items: [] } }); assert.equal(upd.status, 200);
  assert.equal((await (await req(env, '/api/arrange/board?id=' + id)).json()).layout.items.length, 0);
  assert.equal((await req(env, '/api/arrange/board?id=zzzzzzzzzz')).status, 404);
  assert.equal((await req(env, '/api/arrange/board', { layout: { items: [] } })).status, 400);
  const row = env.OPS_DB._db.prepare('SELECT edit FROM sh_arrange WHERE id = ?').get(id); assert.notEqual(row.edit, edit, 'the edit token is stored hashed');
  for (let i = 0; i < SHARES_PER_HOUR; i++) await req(env, '/api/arrange/board', { layout }, '9.9.9.9');
  assert.equal((await req(env, '/api/arrange/board', { layout }, '9.9.9.9')).status, 429);
  assert.ok(['arrange_view', 'arrange_start', 'arrange_add', 'arrange_3d', 'arrange_copy'].every(e => CLIENT_EVENTS.has(e)) && SERVER_EVENTS.has('arrange_share'));
});

test('the page is served on showhaus.app/arrange/ and the walk viewer links plans that are published there', async () => {
  const env = makeEnv();
  const page = await (await req(env, '/arrange/')).text(); assert.match(page, /Will your furniture fit\?/); assert.match(page, /Let buyers furnish your listing/);
  assert.match(readFileSync(new URL('dist/showhaus/index.html', ROOT), 'utf8'), /href="\.\/arrange\/\?src=home-start" data-path="arrange"/);
  assert.match(readFileSync(new URL('dist/showhaus/walk/walk.js', ROOT), 'utf8'), /\.\.\/arrange\/plans\/index\.json/);
});
