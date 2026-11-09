// SHOWHAUS claim flow (src/claim.js): validation, domain-match verification, guest token, rate limit, uploads, share links.
// Runs the real Worker against an in-memory D1 shim (node:sqlite), like showhaus-ops.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { resetForTests } from '../src/ops/store.js';
import { resetClaimsForTests, validAbn, parseLicence, verdict, siteDomain, websiteHost, sniff, validateClaim, MAX_FILE } from '../src/claim.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.run())), _db: db };
}
const project = { project: { name: 'Arncliffe Central', address: '26–42 Eden Street, Arncliffe NSW 2205' } };
function makeEnv(extra = {}) {
  resetForTests(); resetClaimsForTests();
  return {
    OPS_DB: d1(),
    ASSETS: { fetch: async req => new URL(req.url).pathname === '/showhaus/studio/data/arncliffe-central.json' ? Response.json(project) : new Response('nf', { status: 404 }) },
    ...extra,
  };
}
const ctx = () => { const p = []; return { waitUntil: x => p.push(x), done: () => Promise.all(p) }; };
const UA = { 'user-agent': 'Mozilla/5.0 Safari' };
const base = { p: 'arncliffe-central', mode: 'guest', role: 'listing_agent', company: 'Harbour Realty', licence: '51 824 753 556', website: 'https://www.harbourrealty.com.au', email: 'sam@harbourrealty.com.au' };
function form(fields, file) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  if (file) f.set('file', new Blob([file.bytes], { type: file.type || 'application/octet-stream' }), file.name || 'evidence.pdf');
  return f;
}
const submit = (env, fields, { file, headers = {}, host = 'https://showhaus.app' } = {}) =>
  worker.fetch(new Request(host + '/api/claim/submit', { method: 'POST', body: form({ ...base, ...fields }, file), headers: { ...UA, 'cf-connecting-ip': '203.0.113.9', ...headers } }), env, ctx());
const events = env => env.OPS_DB._db.prepare('SELECT name, env, props FROM sh_events ORDER BY id').all();
const pdf = n => { const b = new Uint8Array(n); b.set([0x25, 0x50, 0x44, 0x46, 0x2d]); return b; };

test('ABN checksum (ATO algorithm) and the ABN-or-licence field', () => {
  assert.equal(validAbn('51 824 753 556'), true); // ATO's published example
  assert.equal(validAbn('51824753557'), false);
  assert.equal(validAbn('5182475355'), false);
  assert.deepEqual(parseLicence('51 824 753 556'), { kind: 'abn', value: '51824753556' });
  assert.ok(parseLicence('51824753557').error);
  assert.deepEqual(parseLicence('10012345'), { kind: 'licence', value: '10012345' });
  assert.deepEqual(parseLicence('lic-20 077'), { kind: 'licence', value: 'LIC20077' });
  assert.ok(parseLicence('x').error);
});

test('verification: work-email domain must match the company website; free mail never matches', () => {
  assert.equal(siteDomain('www.raywhite.com.au'), 'raywhite.com.au');
  assert.equal(siteDomain('arncliffe.raywhite.com.au'), 'raywhite.com.au');
  assert.equal(siteDomain('mail.billbergia.com'), 'billbergia.com');
  assert.equal(websiteHost('Billbergia.com/projects?x=1'), 'billbergia.com');
  assert.equal(websiteHost('not a site'), null);
  assert.deepEqual(verdict('jo@billbergia.com.au', 'https://www.billbergia.com.au/'), { status: 'verified', reason: 'domain_match' });
  assert.deepEqual(verdict('jo@arncliffe.raywhite.com.au', 'raywhite.com.au'), { status: 'verified', reason: 'domain_match' });
  assert.deepEqual(verdict('jo@raywhite.com', 'raywhite.com.au'), { status: 'pending', reason: 'domain_mismatch' });
  assert.deepEqual(verdict('jo@gmail.com', 'gmail.com'), { status: 'pending', reason: 'free_mail' });
  assert.deepEqual(verdict('jo@agency.com.au', 'outlook.com'), { status: 'pending', reason: 'free_mail_site' });
  assert.deepEqual(verdict('jo@com.au', 'x.com.au'), { status: 'pending', reason: 'domain_mismatch' });
});

test('validation names every bad field; file types are sniffed from bytes, not names', () => {
  const v = validateClaim({ mode: 'x', role: 'ceo', company: 'A', licence: '123', website: 'nope', email: 'nope' });
  assert.equal(v.ok, false);
  assert.deepEqual(Object.keys(v.errors).sort(), ['company', 'email', 'licence', 'mode', 'role', 'website']);
  assert.equal(validateClaim(base).ok, true);
  assert.equal(validateClaim({ ...base, company: '<script>Harbour</script>' }).value.company, 'script Harbour /script');
  assert.equal(sniff(pdf(10)), 'application/pdf');
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'image/png');
  assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniff(new TextEncoder().encode('<html>')), null);
});

test('guest claim with matching domains: verified, share link + embed, token in an HttpOnly cookie, no raw email stored', async () => {
  const env = makeEnv();
  const r = await submit(env, {});
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.claim.status, 'verified');
  assert.match(b.claim.share_url, /^https:\/\/showhaus\.app\/s\/arncliffe-central\/[a-z2-9]{6}$/);
  assert.match(b.claim.embed, /data-by="[a-z2-9]{6}"/);
  assert.match(b.manage_url, /^https:\/\/showhaus\.app\/claim\/\?p=arncliffe-central#m=[0-9a-f]{48}$/);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^sh_claim=[0-9a-f]{48}; Path=\/; HttpOnly; SameSite=Lax/);
  const dump = JSON.stringify(env.OPS_DB._db.prepare('SELECT * FROM sh_claims').all()) + JSON.stringify(events(env));
  assert.ok(!dump.includes('sam@'), 'the work email address is never stored');
  assert.ok(dump.includes('harbourrealty.com.au'), 'its domain is');
  assert.ok(!dump.includes(b.manage_url.split('#m=')[1]), 'the guest token is stored hashed only');

  // the cookie brings the claim back on the claim page
  const st = await (await worker.fetch(new Request('https://showhaus.app/api/claim/state?p=arncliffe-central', { headers: { cookie: cookie.split(';')[0] } }), env, ctx())).json();
  assert.equal(st.mine.length, 1); assert.equal(st.mine[0].code, b.claim.code);
  assert.equal(st.property.name, 'Arncliffe Central');
  const none = await (await worker.fetch(new Request('https://showhaus.app/api/claim/state?p=arncliffe-central'), env, ctx())).json();
  assert.equal(none.mine.length, 0, 'another browser sees nothing');

  // the public walkthrough may show the verified company
  const brand = await (await worker.fetch(new Request(`https://showhaus.app/api/claim/brand?c=${b.claim.code}`), env, ctx())).json();
  assert.deepEqual(brand, { company: 'Harbour Realty', slug: 'arncliffe-central' });
  const names = events(env).map(e => e.name);
  assert.deepEqual(names, ['claim_submitted', 'claim_verified']);
  assert.equal(events(env)[0].env, 'production');
});

test('mismatched domains stay pending; the public page shows no branding; CVF summary lists it', async () => {
  const env = makeEnv();
  const b = await (await submit(env, { email: 'sam@gmail.com', role: 'developer' })).json();
  assert.equal(b.claim.status, 'pending'); assert.equal(b.claim.reason, 'free_mail');
  const brand = await (await worker.fetch(new Request(`https://showhaus.app/api/claim/brand?c=${b.claim.code}`), env, ctx())).json();
  assert.deepEqual(brand, {});
  assert.deepEqual(events(env).map(e => e.name), ['claim_submitted']);
  const { claimSummary } = await import('../src/claim.js');
  const s = await claimSummary(env);
  assert.equal(s.pending.length, 1); assert.equal(s.pending[0].company, 'Harbour Realty'); assert.equal(s.pending[0].email_domain, 'gmail.com');
  assert.equal(s.counts.production.pending, 1);
});

test('bad input → 400 with field errors; unknown property → 404; cross-origin → 403', async () => {
  const env = makeEnv();
  const r = await submit(env, { licence: '51824753557', website: '' });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys((await r.json()).fields).sort(), ['licence', 'website']);
  assert.equal((await submit(env, { p: 'nowhere' })).status, 404);
  assert.equal((await submit(env, {}, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(env.OPS_DB._db.prepare('SELECT COUNT(*) AS n FROM sh_claims').get().n, 0);
});

test('manage link restores the claim in a new browser; release withdraws it and its branding', async () => {
  const env = makeEnv();
  const b = await (await submit(env, {})).json();
  const token = b.manage_url.split('#m=')[1];
  const post = (p, body) => worker.fetch(new Request('https://showhaus.app/api/claim/' + p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), env, ctx());
  const m = await post('manage', { token });
  assert.equal(m.status, 200); assert.equal((await m.json()).claim.code, b.claim.code);
  assert.match(m.headers.get('set-cookie'), new RegExp('sh_claim=' + token));
  assert.equal((await post('manage', { token: 'f'.repeat(48) })).status, 404);
  assert.equal((await post('release', { token })).status, 200);
  assert.equal((await post('manage', { token })).status, 404);
  assert.deepEqual(await (await worker.fetch(new Request(`https://showhaus.app/api/claim/brand?c=${b.claim.code}`), env, ctx())).json(), {});
});

test('the same work email re-claiming updates one claim and keeps its share link', async () => {
  const env = makeEnv();
  const a = await (await submit(env, { website: 'other.com.au' })).json();
  assert.equal(a.claim.status, 'pending');
  const b = await (await submit(env, {})).json();
  assert.equal(b.updated, true); assert.equal(b.claim.code, a.claim.code); assert.equal(b.claim.status, 'verified');
  assert.equal(env.OPS_DB._db.prepare('SELECT COUNT(*) AS n FROM sh_claims').get().n, 1);
});

test('sign-up mode ties the claim to the email account (shows up after sign-in with that email)', async () => {
  const env = makeEnv();
  const b = await (await submit(env, { mode: 'signup' })).json();
  const row = env.OPS_DB._db.prepare('SELECT owner, email_h, mode FROM sh_claims').get();
  assert.equal(row.mode, 'signup'); assert.equal(row.owner, 'u:' + row.email_h);
  // a session for that account sees the claim without the cookie
  env.OPS_DB._db.prepare("INSERT INTO sh_users (id, created_at, env) VALUES (?, '2026-11-09', 'production')").run(row.email_h);
  const { sha256 } = await import('../src/ops/store.js');
  env.OPS_DB._db.prepare('INSERT INTO sh_sessions (token_h, user_id, exp) VALUES (?, ?, ?)').run(await sha256('sess1'), row.email_h, Date.now() + 1e6);
  const st = await (await worker.fetch(new Request('https://showhaus.app/api/claim/state?p=arncliffe-central', { headers: { cookie: 'sh_s=sess1' } }), env, ctx())).json();
  assert.equal(st.mine.length, 1); assert.equal(st.mine[0].code, b.claim.code);
});

test('rate limit: six claims per connection per hour, then 429', async () => {
  const env = makeEnv();
  for (let i = 0; i < 6; i++) assert.equal((await submit(env, { email: `a${i}@harbourrealty.com.au` })).status, 200);
  assert.equal((await submit(env, { email: 'a9@harbourrealty.com.au' })).status, 429);
  assert.equal((await submit(env, { email: 'a9@harbourrealty.com.au' }, { headers: { 'cf-connecting-ip': '198.51.100.1' } })).status, 200, 'another connection is unaffected');
  const rate = JSON.stringify(env.OPS_DB._db.prepare('SELECT * FROM sh_claim_rate').all());
  assert.ok(!rate.includes('203.0.113.9'), 'IP addresses are only kept as pseudonyms');
});

test('evidence upload: ≤ 2 MB PDF stored in chunks and served to CVF only; oversize and wrong types refused', async () => {
  const env = makeEnv();
  assert.equal((await submit(env, {}, { file: { bytes: pdf(MAX_FILE + 1) } })).status, 413);
  assert.equal((await submit(env, {}, { file: { bytes: new TextEncoder().encode('<html>hi</html>'), name: 'x.pdf' } })).status, 415);
  const bytes = pdf(1_300_000); bytes[1_299_999] = 7;
  const b = await (await submit(env, {}, { file: { bytes, name: 'authority to market.pdf' } })).json();
  assert.deepEqual(b.claim.file, { name: 'authority to market.pdf', bytes: 1_300_000 });
  assert.equal(env.OPS_DB._db.prepare('SELECT COUNT(*) AS n FROM sh_claim_files').get().n, 3);
  const { claimFile } = await import('../src/claim.js');
  const f = await claimFile(env, b.claim.id);
  const back = new Uint8Array(await f.arrayBuffer());
  assert.equal(back.length, 1_300_000); assert.equal(back[1_299_999], 7); assert.equal(f.headers.get('content-type'), 'application/pdf');
  const r = await worker.fetch(new Request(`https://showhaus.app/api/ops/claim-file?id=${b.claim.id}`), env, ctx());
  assert.equal(r.status, 401, 'evidence needs the CVF OIDC token');
});

test('share links redirect to the walkthrough (with the claimant code); synthetic traffic stays synthetic', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request('https://showhaus.app/s/arncliffe-central/abc234'), env, ctx());
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'https://showhaus.app/studio/?p=arncliffe-central&by=abc234&src=share');
  const p = await worker.fetch(new Request('https://x.workers.dev/s/arncliffe-central'), env, ctx());
  assert.equal(p.headers.get('location'), 'https://x.workers.dev/showhaus/studio/?p=arncliffe-central&src=share');
  await submit(env, { env: 'synthetic' });
  await submit(env, { email: 'b@harbourrealty.com.au' }, { headers: { 'user-agent': 'HeadlessChrome playwright' } });
  await submit(env, { email: 'c@harbourrealty.com.au' }, { host: 'https://x.workers.dev' });
  assert.deepEqual([...new Set(events(env).map(e => e.env))], ['synthetic', 'test']);
  assert.equal(env.OPS_DB._db.prepare("SELECT COUNT(*) AS n FROM sh_claims WHERE env = 'production'").get().n, 0);
});

test('claim page beacons are accepted; server-only claim events cannot be forged by a page', async () => {
  const env = makeEnv();
  const c = ctx();
  const beacon = name => worker.fetch(new Request('https://showhaus.app/api/e', { method: 'POST', body: JSON.stringify({ name, anon: 'b1', path: '/claim/', props: { kind: 'claim:arncliffe-central' } }), headers: { 'content-type': 'application/json', ...UA } }), env, c);
  for (const n of ['claim_viewed', 'claim_started', 'claim_guest', 'claim_signup', 'share_link_copied']) assert.equal((await beacon(n)).status, 204);
  assert.equal((await beacon('claim_verified')).status, 400);
  assert.equal((await beacon('claim_submitted')).status, 400);
  await c.done();
  assert.equal(events(env).length, 5);
});
