// SHOWHAUS walk listings (dist/showhaus/walk): labels chosen from data, data integrity, and the Worker routes that
// connect a walk listing to the claim flow and the event store. Runs the real Worker against dist/ and an in-memory D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import worker, { rewrite } from '../src/worker.js';
import { resetForTests } from '../src/ops/store.js';
import { resetClaimsForTests, claimSummary, claimFile } from '../src/claim.js';
import { recordStripeEvent } from '../src/ops/stripe.js';
import { normalizePlanUrl, suggestSummary, resetSuggestForTests, PER_HOUR, suggestBuilt, walkQueue, normalizeAddress, prettyAddress, suggestionKey, GURAS, PHOTON } from '../src/suggest.js';
import { CLIENT_EVENTS } from '../src/ops/events.js';
import { env as localEnv } from './showhaus-local-worker.mjs';
import { labels, BASIS } from '../dist/showhaus/walk/walk.js';

const WALK = fileURLToPath(new URL('../dist/showhaus/walk/', import.meta.url));
const read = async p => JSON.parse(await readFile(WALK + p, 'utf8'));
const exists = p => access(WALK + p).then(() => true, () => false);
const UA = { 'user-agent': 'Mozilla/5.0 Safari' };
const ctx = () => { const p = []; return { waitUntil: x => p.push(x), done: () => Promise.all(p) }; };
function makeEnv() { resetForTests(); resetClaimsForTests(); resetSuggestForTests(); for (const t of ['sh_claims', 'sh_events', 'sh_private', 'sh_private_pending', 'sh_finishes', 'sh_finish_files', 'sh_claim_rate', 'sh_suggest', 'sh_suggest_votes', 'sh_fixes', 'sh_suggest_notify', 'sh_suggest_geo']) { try { localEnv.OPS_DB._db.exec(`DELETE FROM ${t}`); } catch { /* table not created yet */ } } return localEnv; }
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
  const t = labels({ source: 'plan' }, { claimed: true, company: 'Harbour Homes', private: false });
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

test('promise: the card tells voters that the most-voted homes are made photoreal first', async () => {
  const js = await readFile(WALK + 'walk.js', 'utf8');
  assert.match(js, /const PROMISE = 'Homes with the most votes are made photoreal first\.'/);
  assert.equal((js.match(/\$\{PROMISE\}/g) || []).length, 2, 'shown before and after voting');
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
  assert.deepEqual(await (await get(env, '/api/claim/public?p=buildtec-avalon')).json(), { claimed: false, company: null, private: false });
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
  assert.deepEqual(await (await get(env, '/api/claim/public?p=buildtec-avalon')).json(), { claimed: true, company: 'Harbour Homes', private: false });
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

// ---------- private listings and paid real finishes ----------
const builder = { p: 'buildtec-avalon', mode: 'guest', role: 'builder', company: 'Harbour Homes', licence: '51 824 753 556', website: 'https://www.harbourhomes.com.au', email: 'sam@harbourhomes.com.au' };
async function claimAs(env, fields = {}, ip = '203.0.113.9') {
  const f = new FormData();
  for (const [k, v] of Object.entries({ ...builder, ...fields })) f.set(k, v);
  const c = ctx();
  const r = await worker.fetch(new Request('https://showhaus.app/api/claim/submit', { method: 'POST', body: f, headers: { ...UA, 'cf-connecting-ip': ip } }), env, c);
  await c.done();
  return { body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const post = (env, path, body, cookie) => worker.fetch(new Request('https://showhaus.app' + path, { method: 'POST', body: JSON.stringify(body), headers: { ...UA, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }), env, ctx());
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('private: only a VERIFIED claimant can hide a home; then its scene files are gone for everyone', async () => {
  const env = makeEnv();
  const { body, cookie } = await claimAs(env, { intent: 'private' });
  assert.equal(body.claim.role_label, 'Home builder');
  assert.equal(body.private, false, 'an unverified request hides nothing'); assert.equal(body.private_pending, true);
  assert.equal((await get(env, '/walk/data/buildtec-avalon.json')).status, 200);
  assert.equal((await post(env, '/api/claim/private', { id: body.claim.id, on: true }, cookie)).status, 403, 'pending claim cannot hide it');
  assert.equal((await post(env, '/api/claim/private', { id: body.claim.id, on: true })).status, 404, 'a stranger who knows the id cannot either');
  env.OPS_DB._db.prepare("UPDATE sh_claims SET status = 'verified' WHERE id = ?").run(body.claim.id);
  const on = await post(env, '/api/claim/private', { id: body.claim.id, on: true }, cookie);
  assert.equal(on.status, 200); assert.equal((await on.json()).private_by_me, true);
  assert.deepEqual(await (await get(env, '/api/claim/public?p=buildtec-avalon')).json(), { claimed: false, company: null, private: true });
  for (const f of ['/walk/data/buildtec-avalon.json', '/walk/data/buildtec-avalon/room.js', '/walk/data/buildtec-avalon/walk1.mp4', '/walk/data/buildtec-avalon/poster.jpg']) {
    const r = await get(env, f);
    assert.equal(r.status, 410, f); assert.equal(await r.text(), "This home has been made private at the builder's request.");
  }
  assert.equal((await get(env, '/showhaus/walk/data/buildtec-avalon/room.js', 'https://x.workers.dev')).status, 410, 'the workers.dev path is closed too');
  assert.equal((await get(env, '/walk/data/index.json')).status, 200);
  assert.equal((await get(env, '/walk/')).status, 200);
  const st = await (await worker.fetch(new Request('https://showhaus.app/api/claim/state?p=buildtec-avalon', { headers: { ...UA, cookie } }), env, ctx())).json();
  assert.equal(st.private, true); assert.equal(st.mine.length, 1, 'the claimant can still manage it');
  assert.equal((await claimSummary(env)).private[0].slug, 'buildtec-avalon');
  // another verified claimant cannot undo it; the one who hid it can
  const other = await claimAs(env, { company: 'Other Co', website: 'https://other.com.au', email: 'a@other.com.au' }, '203.0.113.10');
  env.OPS_DB._db.prepare("UPDATE sh_claims SET status = 'verified' WHERE id = ?").run(other.body.claim.id);
  await post(env, '/api/claim/private', { id: other.body.claim.id, on: false }, other.cookie);
  assert.equal((await (await get(env, '/api/claim/public?p=buildtec-avalon')).json()).private, true);
  await post(env, '/api/claim/private', { id: body.claim.id, on: false }, cookie);
  assert.equal((await get(env, '/walk/data/buildtec-avalon/room.js')).status, 200);
  assert.ok(env.OPS_DB._db.prepare("SELECT COUNT(*) AS n FROM sh_events WHERE name = 'listing_private'").get().n >= 2);
});

test('private: the viewer, gallery and map all honour it, in English', async () => {
  const js = await readFile(WALK + 'walk.js', 'utf8');
  assert.match(js, /PRIVATE_NOTE = 'This home has been made private at the builder\\u2019s request\.'/);
  assert.match(js, /claim\.private\) \{[^}]*fail\(PRIVATE_NOTE\)/);
  assert.match(js, /g-card--private/);
  assert.match(await readFile(WALK + '../app.js', 'utf8'), /c\.private\) a\.remove\(\)/);
});

test('finishes: the claimant pays; nothing is uploaded before payment, and no price exists until one is configured', async () => {
  const env = makeEnv();
  const { body, cookie } = await claimAs(env);
  assert.deepEqual(body.offer, { price: null, pay: false });
  const ask = await (await post(env, '/api/claim/finishes', { id: body.claim.id }, cookie)).json();
  assert.equal(ask.finishes, 'requested'); assert.equal(ask.pay_url, null);
  assert.equal((await post(env, '/api/claim/finishes', { id: body.claim.id })).status, 404, 'only the claimant');
  const upload = async bytes => { const f = new FormData(); f.set('id', body.claim.id); f.set('file', new Blob([bytes]), 'kitchen.png'); return worker.fetch(new Request('https://showhaus.app/api/claim/finishes-file', { method: 'POST', body: f, headers: { ...UA, cookie } }), env, ctx()); };
  assert.equal((await upload(PNG)).status, 402, 'upload is closed until paid');
  assert.equal((await get(env, '/pay/finishes?c=' + body.claim.code + '&p=buildtec-avalon')).headers.get('location'), 'https://showhaus.app/claim/?p=buildtec-avalon', 'no price set: no checkout');
  // price + link configured by the owner
  const priced = { ...env, FINISHES_PRICE_LABEL: 'A$1 test', FINISHES_PAYMENT_LINK: 'https://buy.stripe.com/test_abc' };
  const ask2 = await (await post(priced, '/api/claim/finishes', { id: body.claim.id }, cookie)).json();
  assert.deepEqual(ask2.offer, { price: 'A$1 test', pay: true }); assert.equal(ask2.pay_url, '/pay/finishes?c=' + body.claim.code + '&p=buildtec-avalon');
  const to = (await get(priced, ask2.pay_url)).headers.get('location');
  assert.equal(to, 'https://buy.stripe.com/test_abc?client_reference_id=fin_' + body.claim.id);
  assert.equal((await recordStripeEvent(priced, { id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { payment_status: 'paid', amount_total: 100, currency: 'aud', client_reference_id: 'fin_' + body.claim.id } } })).status, 200);
  assert.equal(env.OPS_DB._db.prepare('SELECT status FROM sh_finishes WHERE claim_id = ?').get(body.claim.id).status, 'paid');
  assert.equal((await upload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).status, 415);
  const ok = await upload(PNG);
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, files: 1, max: 12, finishes: 'uploaded' });
  const file = await claimFile(env, body.claim.id, 1);
  assert.equal(file.headers.get('content-type'), 'image/png'); assert.equal((await file.arrayBuffer()).byteLength, PNG.length);
  const sum = await claimSummary(env);
  assert.equal(sum.finishes[0].status, 'uploaded'); assert.equal(sum.finishes[0].files, 1);
});

test('claim page: says what a claim gives and who pays, with no price in the page', async () => {
  const html = await readFile(WALK + '../claim/index.html', 'utf8'), js = await readFile(WALK + '../claim/claim.js', 'utf8');
  assert.match(html, /Paid by you<\/b> Your real finishes on the walk\. Price shown before any charge\./);
  assert.match(html, /Or make it private, any time\./);
  for (const t of [html, js]) assert.doesNotMatch(t, /\$\s?\d|AUD\s?\d/);
});

// ---------- no-login community input ----------
const sg = (env, path, body, ip = '198.51.100.7', headers = {}) => { const c = ctx(); return worker.fetch(new Request('https://showhaus.app' + path, { method: 'POST', body: JSON.stringify(body), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605', 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers } }), env, c).then(async r => { await c.done(); return r; }); };

test('suggest: one home is one key — https, no tracking, no fragment; private and own hosts are refused', () => {
  assert.deepEqual(normalizePlanUrl('WWW.Buildtec.com.au/home-designs/avalon/?utm_source=x&b=2&a=1#plan'), { url: 'https://buildtec.com.au/home-designs/avalon?a=1&b=2', host: 'buildtec.com.au' });
  assert.equal(normalizePlanUrl('http://buildtec.com.au/home-designs/avalon').url, 'https://buildtec.com.au/home-designs/avalon');
  for (const bad of ['', 'not a link', 'javascript:alert(1)', 'https://localhost/x', 'https://10.0.0.1/x', 'https://showhaus.app/walk/', 'https://user:pw@site.com/x', 'ftp://site.com/x', 'https://site.com:8443/x', 'https://site.com/' + 'a'.repeat(400)]) assert.equal(normalizePlanUrl(bad), null, bad);
});

test('suggest: a link needs no login, the same link adds up as votes, and one visitor counts once', async () => {
  const env = makeEnv();
  const a = await (await sg(env, '/api/suggest/home', { url: 'https://buildtec.com.au/home-designs/avalon?utm_source=fb', anon: 'visitor-one-1' })).json();
  assert.deepEqual(a, { ok: true, votes: 1, counted: true, host: 'buildtec.com.au', notify: false });
  const again = await (await sg(env, '/api/suggest/home', { url: 'buildtec.com.au/home-designs/avalon/', anon: 'visitor-one-1' })).json();
  assert.equal(again.votes, 1); assert.equal(again.counted, false);
  assert.equal((await (await sg(env, '/api/suggest/home', { url: 'https://www.buildtec.com.au/home-designs/avalon', anon: 'visitor-two-2' }, '198.51.100.8')).json()).votes, 2);
  assert.equal((await sg(env, '/api/suggest/home', { url: 'nope' })).status, 400);
  assert.equal((await sg(env, '/api/suggest/home', { url: 'https://a.com/x' }, '198.51.100.9', { origin: 'https://evil.example' })).status, 403);
  const sum = await suggestSummary(env);
  assert.equal(sum.homes.length, 1); assert.equal(sum.homes[0].votes, 2); assert.equal(sum.homes[0].url, 'https://buildtec.com.au/home-designs/avalon');
  assert.deepEqual(await (await get(env, '/api/suggest/count')).json(), { homes: 1 }, 'visitors see a number, never the links');
  const ev = env.OPS_DB._db.prepare("SELECT props, actor FROM sh_events WHERE name = 'home_suggested'").all();
  assert.equal(ev.length, 2); assert.equal(JSON.parse(ev[0].props).ref, 'buildtec.com.au', 'the event keeps the host only');
});

test('suggest: a fix report is a room and one line on a real, public walk; nothing personal is kept', async () => {
  const env = makeEnv();
  assert.equal((await sg(env, '/api/suggest/fix', { p: 'buildtec-avalon', room: 'Kitchen', note: 'The island is on the wrong side <b>', email: 'a@b.co' })).status, 200);
  assert.equal((await sg(env, '/api/suggest/fix', { p: 'buildtec-avalon', note: 'no' })).status, 400);
  assert.equal((await sg(env, '/api/suggest/fix', { p: 'no-such-home', note: 'something is off' })).status, 404);
  const row = env.OPS_DB._db.prepare('SELECT * FROM sh_fixes').all();
  assert.equal(row.length, 1); assert.equal(row[0].room, 'Kitchen'); assert.equal(row[0].note, 'The island is on the wrong side b');
  assert.ok(!JSON.stringify(row).includes('a@b.co'));
  assert.equal((await suggestSummary(env)).fixes[0].slug, 'buildtec-avalon');
});

test('suggest: ten submissions per connection per hour, then 429', async () => {
  const env = makeEnv();
  for (let i = 0; i < PER_HOUR; i++) assert.equal((await sg(env, '/api/suggest/home', { url: 'https://site.com.au/plan-' + i }, '198.51.100.20')).status, 200);
  assert.equal((await sg(env, '/api/suggest/home', { url: 'https://site.com.au/plan-x' }, '198.51.100.20')).status, 429);
});

test('suggest: the page offers both inputs with no sign-up and never lists submitted links', async () => {
  const html = await readFile(WALK + 'index.html', 'utf8'), js = await readFile(WALK + 'walk.js', 'utf8');
  assert.match(html, /id="suggest"/); assert.match(html, /id="fixOpen"/); assert.match(html, /no sign-up/i);
  assert.doesNotMatch(html, /type="file"/, 'links only: no file upload from visitors');
  assert.doesNotMatch(js, /api\/suggest\/(homes|list)/);
});

test('notify: the email is optional, used for one message when the home is live, then deleted', async () => {
  const env = makeEnv();
  const U = 'https://buildtec.com.au/home-designs/avalon';
  assert.equal((await (await sg(env, '/api/suggest/home', { url: U, anon: 'visitor-aaa-1' })).json()).notify, false);
  assert.equal((await sg(env, '/api/suggest/home', { url: U, email: 'nope', anon: 'visitor-bbb-2' }, '198.51.100.31')).status, 400);
  assert.equal((await (await sg(env, '/api/suggest/home', { url: U, email: ' Pat@Example.com ', anon: 'visitor-ccc-3' }, '198.51.100.32')).json()).notify, true);
  assert.equal((await suggestSummary(env)).homes[0].url, U);
  assert.ok(!JSON.stringify(await suggestSummary(env)).includes('pat@example.com'), 'the summary never carries addresses');
  assert.equal((await worker.fetch(new Request('https://showhaus.app/api/ops/suggest-built', { method: 'POST', body: '{}' }), env, ctx())).status, 401, 'OIDC only');
  assert.deepEqual(await suggestBuilt(env, { url: U, slug: 'buildtec-avalon' }), { ok: true, sent: 0, waiting: 1, note: 'no mail route configured; addresses kept' });
  const mails = [];
  const mailEnv = { ...env, RESEND_API_KEY: 'k' };
  const fake = async (u, o) => { mails.push(JSON.parse(o.body)); return new Response('{}', { status: 200 }); };
  assert.deepEqual(await suggestBuilt(mailEnv, { url: U + '/?utm_source=x', slug: 'buildtec-avalon' }, fake), { ok: true, sent: 1, failed: 0 });
  assert.deepEqual(mails[0].to, ['pat@example.com']); assert.match(mails[0].text, /showhaus\.app\/walk\/\?p=buildtec-avalon/); assert.match(mails[0].from, /^SHOWHAUS </);
  assert.equal(env.OPS_DB._db.prepare('SELECT COUNT(*) AS n FROM sh_suggest_notify').get().n, 0, 'address deleted after the one email');
  assert.deepEqual(await suggestBuilt(mailEnv, { url: U, slug: 'buildtec-avalon' }, fake), { ok: true, sent: 0, failed: 0 }); assert.equal(mails.length, 1, 'never twice');
  assert.equal((await walkQueue(env)).base.length, 0, 'a built home leaves the queue');
});

test('queue: asked-for homes by votes, photoreal by net votes (last vote or cancel counts), paid finishes oldest first', async () => {
  const env = makeEnv();
  const db = env.OPS_DB._db;
  for (const [u, n] of [['https://a.com.au/one', 1], ['https://b.com.au/two', 3], ['https://c.com.au/three', 2]])
    for (let i = 0; i < n; i++) await sg(env, '/api/suggest/home', { url: u, anon: `voter-${u.length}-${i}-xx` }, `198.51.100.${40 + i}`);
  await sg(env, '/api/suggest/home', { url: 'https://probe.com.au/x', anon: 'probe-visitor-1' }, '198.51.100.60', { 'x-cvf-synthetic': '1' });
  await (await import('../src/suggest.js')).walkQueue(env); // tables exist
  const ev = (name, actor, slug, at) => db.prepare("INSERT INTO sh_events (at, name, env, source, actor, props) VALUES (?, ?, 'production', 'client', ?, ?)").run(at, name, actor, JSON.stringify({ kind: 'walk:' + slug }));
  ev('upgrade_interest', 'a:1', 'buildtec-avalon', '2026-11-15T01:00:00Z'); ev('upgrade_interest', 'a:2', 'buildtec-avalon', '2026-11-15T01:01:00Z');
  ev('upgrade_interest_cancel', 'a:2', 'buildtec-avalon', '2026-11-15T01:02:00Z'); ev('upgrade_interest', 'a:1', 'buildtec-avalon', '2026-11-15T01:03:00Z');
  ev('upgrade_interest', 'a:3', 'other-home', '2026-11-15T01:04:00Z'); ev('upgrade_interest', 'a:4', 'other-home', '2026-11-15T01:05:00Z');
  const q = await walkQueue(env);
  assert.deepEqual(q.base.map(b => [b.host, b.votes]), [['b.com.au', 3], ['c.com.au', 2], ['a.com.au', 1]], 'production only, most votes first');
  assert.deepEqual(q.photoreal, [{ slug: 'other-home', votes: 2 }, { slug: 'buildtec-avalon', votes: 1 }]);
  assert.deepEqual(q.finishes, []);
});

// A stand-in for the NSW address register (GURAS ArcGIS query): prefix LIKE and exact = on `address`.
const REGISTER = [['199 FOREST ROAD ARNCLIFFE', 151.134659, -33.941236], ['1/229 FOREST ROAD ARNCLIFFE', 151.1331, -33.9401], ['199 FOREST ROAD KIRRAWEE', 151.077778, -34.040384], ["12 O'CONNELL STREET SYDNEY", 151.2105, -33.8651]];
function fakeGuras(calls = []) {
  return async (u) => {
    const url = new URL(u);
    if (url.origin + url.pathname === PHOTON) { calls.push('photon:' + url.searchParams.get('q')); return new Response(JSON.stringify({ features: [
      { properties: { name: 'Forest Road', district: 'Arncliffe', state: 'New South Wales' }, geometry: { coordinates: [151.1342, -33.9409] } },
      { properties: { name: 'Forest Road', district: 'Arncliffe', state: 'New South Wales' }, geometry: { coordinates: [151.1350, -33.9420] } },
      { properties: { name: 'Forest Road', city: 'Melbourne', state: 'Victoria' }, geometry: { coordinates: [145.0, -37.8] } }] })); }
    assert.equal(url.origin + url.pathname, GURAS); calls.push(url.searchParams.get('where'));
    const w = url.searchParams.get('where'), m = w.match(/^address (LIKE|=) '(.*)'$/); const v = m[2].replace(/''/g, "'");
    const rows = REGISTER.filter(([a]) => (m[1] === '=' ? a === v : a.startsWith(v.replace(/%$/, ''))));
    return new Response(JSON.stringify({ features: rows.slice(0, Number(url.searchParams.get('resultRecordCount'))).map(([a, x, y]) => ({ attributes: { address: a }, geometry: { x, y } })) }));
  };
}

test('address: what people type becomes the register form; anything without a house number is not an address', () => {
  assert.equal(normalizeAddress('199 Forest Rd, Arncliffe NSW 2205'), '199 FOREST ROAD ARNCLIFFE');
  assert.equal(normalizeAddress('Unit 1 229 forest rd arncliffe'), '1/229 FOREST ROAD ARNCLIFFE');
  assert.equal(normalizeAddress('1 / 229 Forest Rd'), '1/229 FOREST ROAD');
  assert.equal(normalizeAddress('12 O’Connell St, Sydney, Australia'), "12 O'CONNELL STREET SYDNEY");
  assert.equal(normalizeAddress('St Kilda Rd'), null); assert.equal(normalizeAddress('12'), null); assert.equal(normalizeAddress("1 X'); DROP TABLE x;--"), "1 X' DROP TABLE X --");
  assert.equal(prettyAddress('199 FOREST ROAD ARNCLIFFE'), '199 Forest Road, Arncliffe NSW');
  assert.equal(prettyAddress("12 O'CONNELL STREET SYDNEY"), "12 O'Connell Street, Sydney NSW");
  assert.equal(suggestionKey('addr:199 forest rd arncliffe'), 'addr:199 FOREST ROAD ARNCLIFFE');
  assert.equal(suggestionKey('https://www.a.com.au/x/?utm_source=1'), 'https://a.com.au/x');
});

test('address: autocomplete proxies the NSW register with a map point, never the visitor, and degrades to free text', async () => {
  const env = makeEnv(), calls = [];
  env.__fetch = fakeGuras(calls);
  try {
    const r = await (await get(env, '/api/suggest/address?q=' + encodeURIComponent('199 forest rd'))).json();
    assert.deepEqual(r.results.map(x => x.label), ['199 Forest Road, Arncliffe NSW', '199 Forest Road, Kirrawee NSW']);
    assert.ok(r.results.every(x => x.kind === 'address'));
    assert.deepEqual(r.results[0].lngLat, [151.134659, -33.941236]);
    assert.equal(calls[0], "address LIKE '199 FOREST ROAD%'");
    const st = (await (await get(env, '/api/suggest/address?q=' + encodeURIComponent('forest rd arncliffe'))).json()).results;
    assert.deepEqual(st, [{ kind: 'street', label: 'Forest Road, Arncliffe NSW', fill: 'Forest Road, Arncliffe', lngLat: [151.1342, -33.9409] }], 'no house number yet → NSW streets, one per street and suburb');
    assert.equal(calls[1], 'photon:forest rd arncliffe');
    assert.deepEqual((await (await get(env, '/api/suggest/address?q=12')).json()).results, [], 'nothing to look up');
    assert.equal(calls.length, 2);
    await (await get(env, '/api/suggest/address?q=' + encodeURIComponent("12 o'connell"))).json();
    assert.equal(calls[2], "address LIKE '12 O''CONNELL%'", 'quotes are escaped for the register query');
    env.__fetch = async () => { throw new Error('down'); };
    assert.deepEqual(await (await get(env, '/api/suggest/address?q=199+forest')).json(), { results: [], offline: true });
  } finally { delete env.__fetch; }
});

test('address: a suggested address adds up as votes with its link-free key, is verified when the register knows it, and joins the base queue', async () => {
  const env = makeEnv();
  env.__fetch = fakeGuras();
  try {
    const a = await (await sg(env, '/api/suggest/home', { address: '199 Forest Rd, Arncliffe NSW 2205', anon: 'visitor-adr-1', email: 'pat@example.com' })).json();
    assert.deepEqual([a.ok, a.votes, a.verified, a.address, a.host], [true, 1, true, '199 Forest Road, Arncliffe NSW', 'address']);
    assert.equal((await (await sg(env, '/api/suggest/home', { address: '199 FOREST ROAD ARNCLIFFE', anon: 'visitor-adr-2' }, '198.51.100.71')).json()).votes, 2, 'any spelling is the same home');
    const lot = await (await sg(env, '/api/suggest/home', { address: '7 Newlot Ave, Box Hill', anon: 'visitor-adr-3' }, '198.51.100.72')).json();
    assert.deepEqual([lot.ok, lot.verified, lot.address], [true, false, '7 Newlot Avenue, Box Hill NSW'], 'a lot the register does not know yet is kept, unverified');
    assert.equal((await sg(env, '/api/suggest/home', { address: '12 Smith' })).status, 400, 'number and street and suburb');
    assert.equal((await sg(env, '/api/suggest/home', { address: 'hello there' })).status, 400);
    env.__fetch = async () => { throw new Error('down'); };
    assert.equal((await (await sg(env, '/api/suggest/home', { address: '199 Forest Rd Arncliffe', anon: 'visitor-adr-4' }, '198.51.100.73')).json()).votes, 3, 'register down: still counted');
    const q = await walkQueue(env);
    const top = q.base[0];
    assert.deepEqual({ ...top, at: undefined }, { kind: 'address', key: 'addr:199 FOREST ROAD ARNCLIFFE', address: '199 Forest Road, Arncliffe NSW', lngLat: [151.134659, -33.941236], verified: true, host: 'address', votes: 3, notify: 1, at: undefined }, 'a down register never erases the verified point');
    assert.deepEqual(q.base[1].lngLat, null);
    const sum = JSON.stringify(await suggestSummary(env));
    assert.ok(!sum.includes('pat@example.com'));
    assert.deepEqual(await suggestBuilt(env, { url: top.key, slug: 'arncliffe-199-forest' }), { ok: true, sent: 0, waiting: 1, note: 'no mail route configured; addresses kept' });
    assert.equal((await walkQueue(env)).base.length, 1, 'built homes leave the queue');
  } finally { delete env.__fetch; }
});

test('address: the gallery takes an address first, with a listbox for the register matches', async () => {
  const html = await readFile(WALK + 'index.html', 'utf8'), js = await readFile(WALK + 'walk.js', 'utf8');
  assert.match(html, /Type its address/); assert.match(html, /role="combobox"/); assert.match(html, /id="sgList"[^>]*role="listbox"/);
  assert.match(js, /\/api\/suggest\/address\?q=/); assert.match(js, /initSuggest\(\); \/\/ before any network wait/); assert.doesNotMatch(js, /portal\.spatial\.nsw\.gov\.au/, 'the page never calls the register directly');
});
