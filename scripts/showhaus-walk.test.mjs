// SHOWHAUS walk listings (dist/showhaus/walk): labels chosen from data, data integrity, and the Worker routes that
// connect a walk listing to the claim flow and the event store. Runs the real Worker against dist/ and an in-memory D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import worker, { rewrite } from '../src/worker.js';
import { resetForTests } from '../src/ops/store.js';
import { resetClaimsForTests } from '../src/claim.js';
import { CLIENT_EVENTS } from '../src/ops/events.js';
import { env as localEnv } from './showhaus-local-worker.mjs';
import { labels, BASIS } from '../dist/showhaus/walk/walk.js';

const WALK = fileURLToPath(new URL('../dist/showhaus/walk/', import.meta.url));
const read = async p => JSON.parse(await readFile(WALK + p, 'utf8'));
const exists = p => access(WALK + p).then(() => true, () => false);
const UA = { 'user-agent': 'Mozilla/5.0 Safari' };
const ctx = () => { const p = []; return { waitUntil: x => p.push(x), done: () => Promise.all(p) }; };
function makeEnv() { resetForTests(); resetClaimsForTests(); for (const t of ['sh_claims', 'sh_events']) { try { localEnv.OPS_DB._db.exec(`DELETE FROM ${t}`); } catch { /* table not created yet */ } } return localEnv; }
const get = (env, path, host = 'https://showhaus.app') => worker.fetch(new Request(host + path, { headers: UA, redirect: 'manual' }), env, ctx());

test('labels: the basis line follows the data source and never claims a plan that is not there', () => {
  const plan = labels({ source: 'plan' }, { claimed: false }), est = labels({ source: 'estimate' }, null), odd = labels({ source: 'something-new' }, null);
  assert.equal(plan.badge, 'Not yet owner-claimed');
  assert.match(plan.basis, /may differ from the real home/); assert.match(plan.basis, /published floor plan/); assert.doesNotMatch(plan.basis, /satellite/);
  assert.match(est.basis, /satellite imagery and a world model/); assert.doesNotMatch(est.basis, /floor plan/);
  assert.equal(odd.basis, est.basis, 'an unknown source falls back to the weaker claim');
  assert.equal(plan.planOk, true); assert.equal(est.planOk, false); assert.match(est.plan, /upload/);
  assert.match(plan.card, /AI visualisation/);
});

test('labels: a verified claim switches the badge and drops the warning', () => {
  const t = labels({ source: 'plan' }, { claimed: true, company: 'Harbour Homes' });
  assert.equal(t.badge, 'Owner-claimed'); assert.equal(t.basis, BASIS.plan); assert.match(t.card, /Harbour Homes/);
});

test('data: every listed walk has its listing file, scene, atlases, photos and poster', async () => {
  const idx = await read('data/index.json');
  assert.ok(idx.items.length >= 1);
  for (const it of idx.items) {
    assert.match(it.slug, /^[a-z0-9-]{3,80}$/);
    assert.ok(it.lngLat === null || (Array.isArray(it.lngLat) && it.lngLat[0] > 140 && it.lngLat[0] < 154 && it.lngLat[1] < -28 && it.lngLat[1] > -38), `${it.slug}: pin is in NSW or absent`);
    if (it.kind !== 'walk') continue;
    const meta = await read(`data/${it.slug}.json`);
    assert.equal(meta.project.name, it.name); assert.equal(meta.listing.slug, it.slug);
    assert.ok(['plan', 'estimate'].includes(meta.listing.source), `${it.slug}: source is plan or estimate`);
    if (meta.listing.source === 'plan') assert.match(meta.listing.source_url, /^https:\/\//, `${it.slug}: a plan-based listing records where the plan came from`);
    assert.ok(await exists(`data/${it.slug}/poster.jpg`), `${it.slug}: poster`);
    if (meta.listing.sample) assert.ok(await exists(`data/${it.slug}/${meta.listing.sample}`), `${it.slug}: sample GIF`);
    globalThis.window = {}; await import(`${WALK}data/${it.slug}/room.js`); const R = globalThis.window.ROOM; delete globalThis.window;
    for (const g of Object.values(R.groups)) assert.ok(await exists(`data/${it.slug}/${g.atlas}`), `${it.slug}: atlas ${g.atlas}`);
    for (const v of R.views) for (const f of [v.photo, v.clip]) if (f) assert.ok(await exists(`data/${it.slug}/${f}`), `${it.slug}: ${f}`);
    const inWalk = (x, y) => R.walk.some(b => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) && !R.boxes.some(k => x > k[0] && x < k[2] && y > k[1] && y < k[3]);
    assert.ok(inWalk(...R.views[0].pos), `${it.slug}: the first viewpoint is a place you can stand`);
  }
});

test('wording: only interiors are called a walk; exterior models are pinned as 3D models', async () => {
  const app = await readFile(WALK + '../app.js', 'utf8'), js = await readFile(WALK + 'walk.js', 'utf8');
  assert.match(js, /filter\(it => it\.kind === 'walk'\)/, 'the Walk gallery lists walk listings only');
  assert.match(app, /walk \? '▶ Walk' : '3D'/, 'exterior model shortcut stays semantically distinct from an interior walk');
  assert.match(app, /walk \? 'walk-pin' : 'walk-pin walk-pin--model'/, 'exterior models have separate subdued styling');
  assert.match(app, /Open the 3D model of/, 'the full model meaning is retained in the accessible label');
  const css = await readFile(WALK + '../explore.css', 'utf8');
  assert.match(css, /\.walk-pin--model\s*\{[^}]*box-shadow:\s*none;/s, 'model shortcuts have no promotional drop shadow');
});

test('page: no price anywhere until render cost is measured', async () => {
  for (const f of ['index.html', 'walk.js']) assert.doesNotMatch(await readFile(WALK + f, 'utf8'), /\$\s?\d|AUD\s?\d/, f);
});

test('worker: showhaus.app/walk/ is served from dist/showhaus/walk/', async () => {
  assert.equal(new URL(rewrite('https://showhaus.app/walk/?p=buildtec-avalon').asset).pathname, '/showhaus/walk/');
  const r = await get(makeEnv(), '/walk/data/index.json');
  assert.equal(r.status, 200);
});

test('worker: a walk listing is a claimable property; share links open the walk, Studio links are unchanged', async () => {
  const env = makeEnv();
  const st = await (await get(env, '/api/claim/state?p=buildtec-avalon')).json();
  assert.deepEqual(st.property, { slug: 'buildtec-avalon', kind: 'walk', name: 'Avalon', address: '' });
  assert.equal((await (await get(env, '/api/claim/state?p=arncliffe-central')).json()).property.kind, 'studio');
  assert.equal((await get(env, '/api/claim/state?p=no-such-home')).status, 404);
  assert.equal((await get(env, '/s/buildtec-avalon/abcd12')).headers.get('location'), 'https://showhaus.app/walk/?p=buildtec-avalon&by=abcd12&src=share');
  assert.equal((await get(env, '/s/arncliffe-central')).headers.get('location'), 'https://showhaus.app/studio/?p=arncliffe-central&src=share');
});

test('worker: the public badge flips only for a verified claim, and a walk claim embeds the walk', async () => {
  const env = makeEnv();
  assert.deepEqual(await (await get(env, '/api/claim/public?p=buildtec-avalon')).json(), { claimed: false, company: null });
  const f = new FormData();
  for (const [k, v] of Object.entries({ p: 'buildtec-avalon', mode: 'guest', role: 'listing_agent', company: 'Harbour Homes', licence: '51 824 753 556', website: 'https://www.harbourhomes.com.au', email: 'sam@harbourhomes.com.au' })) f.set(k, v);
  const c = ctx();
  const r = await worker.fetch(new Request('https://showhaus.app/api/claim/submit', { method: 'POST', body: f, headers: { ...UA, 'cf-connecting-ip': '203.0.113.9' } }), env, c);
  await c.done();
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.match(body.claim.embed, /^<iframe src="https:\/\/showhaus\.app\/walk\/\?p=buildtec-avalon&by=[a-z0-9]+&src=embed"/);
  assert.notEqual(body.claim.status, 'verified');
  assert.equal((await (await get(env, '/api/claim/public?p=buildtec-avalon')).json()).claimed, false, 'a pending claim does not change the badge');
  env.OPS_DB._db.prepare("UPDATE sh_claims SET status = 'verified' WHERE slug = ?").run('buildtec-avalon');
  assert.deepEqual(await (await get(env, '/api/claim/public?p=buildtec-avalon')).json(), { claimed: true, company: 'Harbour Homes' });
  assert.equal((await (await get(env, '/api/claim/public?p=arncliffe-central')).json()).claimed, false);
});

test('events: upgrade interest is a page event carrying the listing and nothing personal', async () => {
  for (const n of ['walk_open', 'walk_room', 'upgrade_open', 'upgrade_interest', 'upgrade_interest_cancel']) assert.ok(CLIENT_EVENTS.has(n));
  const env = makeEnv(), c = ctx();
  const r = await worker.fetch(new Request('https://showhaus.app/api/e', { method: 'POST', headers: { ...UA, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'upgrade_interest', anon: 'b7', path: '/walk/?p=buildtec-avalon', props: { kind: 'walk:buildtec-avalon', cta: 'has-plan', email: 'a@b.co' } }) }), env, c);
  await c.done();
  assert.equal(r.status, 204);
  const row = env.OPS_DB._db.prepare("SELECT * FROM sh_events WHERE name = 'upgrade_interest'").get();
  assert.equal(row.path, '/walk/'); assert.deepEqual(JSON.parse(row.props), { kind: 'walk:buildtec-avalon', cta: 'has-plan' });
});
