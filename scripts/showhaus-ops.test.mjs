// SHOWHAUS operations (src/ops/): event contract, email-code sign-in, Stripe webhook, CVF OIDC read side.
// Runs the real Worker handlers against an in-memory D1 shim (node:sqlite), so no Cloudflare account is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { resetForTests } from '../src/ops/store.js';
import { verifyGithubOidc } from '../src/ops/oidc.js';
import { stripeSignature, verifyStripe, classify } from '../src/ops/stripe.js';
import { environmentOf } from '../src/ops/events.js';
import { buildJourneys, funnelOf, channelsOf } from '../src/ops/summary.js';

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
function makeEnv(extra = {}) {
  resetForTests();
  const sent = [];
  return { OPS_DB: d1(), MAIL_SENDING: 'on', MAIL: { send: async m => { sent.push(m); return { messageId: 'm1' }; } }, ASSETS: { fetch: async () => new Response('asset') }, sent, ...extra };
}
const ctx = () => { const p = []; return { waitUntil: x => p.push(x), done: () => Promise.all(p) }; };
const post = (url, body, headers = {}) => new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const rows = env => env.OPS_DB._db.prepare('SELECT name, env, source, actor, path, props FROM sh_events ORDER BY id').all();

test('environment: production only on showhaus.app, probes are synthetic, never upgraded', () => {
  const r = (u, h = {}) => new Request(u, { headers: h });
  assert.equal(environmentOf(r('https://showhaus.app/api/e', { 'user-agent': 'Mozilla/5.0 Safari' })), 'production');
  assert.equal(environmentOf(r('https://x-sydney-environmental-atlas.wldud5192.workers.dev/api/e')), 'test');
  assert.equal(environmentOf(r('https://showhaus.app/api/e', { 'user-agent': 'Mozilla/5.0 cvf-e2e/1.0' })), 'synthetic');
  assert.equal(environmentOf(r('https://showhaus.app/api/e', { 'x-cvf-synthetic': '1' })), 'synthetic');
  assert.equal(environmentOf(r('https://showhaus.app/api/e'), { claimed: 'production' }), 'production');
  assert.equal(environmentOf(r('https://preview.workers.dev/api/e'), { claimed: 'production' }), 'test');
});

test('beacon: only page events, no query strings, referrer host only, no forged payments', async () => {
  const env = makeEnv(), c = ctx();
  assert.equal((await worker.fetch(post('https://showhaus.app/api/e', { name: 'view', anon: 'b1', path: '/?email=a@b.co', props: { ref: 'https://www.google.com/search?q=me', utm_source: 'li', email: 'a@b.co' } }, { 'user-agent': 'Mozilla/5.0' }), env, c)).status, 204);
  assert.equal((await worker.fetch(post('https://showhaus.app/api/e', { name: 'payment_succeeded' }), env, ctx())).status, 400);
  assert.equal((await worker.fetch(post('https://showhaus.app/api/e', { name: 'view' }, { origin: 'https://evil.example' }), env, ctx())).status, 403);
  await c.done();
  const [r] = rows(env);
  assert.equal(r.name, 'view'); assert.equal(r.env, 'production'); assert.equal(r.path, '/');
  assert.match(r.actor, /^a:[0-9a-f]{16}$/);
  assert.deepEqual(JSON.parse(r.props), { utm_source: 'li', ref: 'www.google.com' });
  assert.ok(!JSON.stringify(rows(env)).includes('a@b.co'));
});

test('sign-up then log-in with an emailed code; the email is never stored', async () => {
  const env = makeEnv();
  const start = await worker.fetch(post('https://showhaus.app/api/auth/start', { email: 'Ji.Test@Example.com ' }, { 'user-agent': 'Mozilla/5.0' }), env, ctx());
  assert.equal(start.status, 200);
  assert.equal(env.sent.length, 1); assert.equal(env.sent[0].to, 'ji.test@example.com');
  const code = env.sent[0].subject.slice(0, 6);
  const bad = await worker.fetch(post('https://showhaus.app/api/auth/verify', { email: 'ji.test@example.com', code: '000000' }), env, ctx());
  assert.equal(bad.status, 400);
  const ok = await worker.fetch(post('https://showhaus.app/api/auth/verify', { email: 'ji.test@example.com', code, anon: 'b1' }, { 'user-agent': 'Mozilla/5.0' }), env, ctx());
  assert.equal(ok.status, 200); assert.equal((await ok.json()).new, true);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const me = await (await worker.fetch(new Request('https://showhaus.app/api/auth/me', { headers: { cookie } }), env, ctx())).json();
  assert.equal(me.signedIn, true);
  const reused = await worker.fetch(post('https://showhaus.app/api/auth/verify', { email: 'ji.test@example.com', code }), env, ctx());
  assert.equal(reused.status, 400, 'a code works once');
  await worker.fetch(post('https://showhaus.app/api/auth/start', { email: 'ji.test@example.com' }), env, ctx());
  const again = await worker.fetch(post('https://showhaus.app/api/auth/verify', { email: 'ji.test@example.com', code: env.sent[1].subject.slice(0, 6) }, { 'user-agent': 'Mozilla/5.0' }), env, ctx());
  assert.equal((await again.json()).new, false);
  const names = rows(env).map(r => r.name);
  assert.deepEqual(names.filter(n => n !== 'cta'), ['signup', 'login']);
  const dump = JSON.stringify(env.OPS_DB._db.prepare("SELECT * FROM sh_users").all()) + JSON.stringify(rows(env)) + JSON.stringify(env.OPS_DB._db.prepare('SELECT * FROM sh_codes').all());
  assert.ok(!dump.toLowerCase().includes('example.com'), 'no raw email in the store');
});

test('rate limit: five codes per address per hour', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(post('https://showhaus.app/api/auth/start', { email: 'r@example.com' }), env, ctx())).status, 200);
  assert.equal((await worker.fetch(post('https://showhaus.app/api/auth/start', { email: 'r@example.com' }), env, ctx())).status, 429);
});

test('mail failure is reported to the visitor and recorded without the address', async () => {
  const env = makeEnv({ MAIL: { send: async () => { throw Object.assign(new Error('sender not verified'), { code: 'E_SENDER_NOT_VERIFIED' }); } } });
  const r = await worker.fetch(post('https://showhaus.app/api/auth/start', { email: 'm@example.com' }), env, ctx());
  assert.equal(r.status, 502);
  const h = await (await worker.fetch(new Request('https://showhaus.app/api/ops/health'), env, ctx())).json();
  assert.equal(h.mail_last_error, 'E_SENDER_NOT_VERIFIED');
});

test('test-domain accounts need a CVF OIDC token', async () => {
  const env = makeEnv();
  const r = await worker.fetch(post('https://showhaus.app/api/auth/start', { email: 'p@e2e.showhaus.invalid' }), env, ctx());
  assert.equal(r.status, 400); assert.equal(env.sent.length, 0);
});

test('Stripe webhook: 503 without secret; signed, deduped, PII-free with it', async () => {
  const ev = { id: 'evt_1', type: 'checkout.session.completed', livemode: true, created: 1762590000, data: { object: { amount_total: 125000, currency: 'aud', mode: 'payment', payment_status: 'paid', payment_link: 'plink_1', customer_details: { email: 'buyer@example.com' } } } };
  const body = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  const none = makeEnv();
  const r0 = await worker.fetch(post('https://showhaus.app/hooks/stripe', body), none, ctx());
  assert.equal(r0.status, 503); assert.deepEqual(await r0.json(), { error: 'webhook secret not set' });
  const env = makeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  const good = `t=${t},v1=${await stripeSignature('whsec_test', t, body)}`;
  assert.equal((await worker.fetch(post('https://showhaus.app/hooks/stripe', body, { 'stripe-signature': `t=${t},v1=${await stripeSignature('nope', t, body)}` }), env, ctx())).status, 400);
  const r1 = await worker.fetch(post('https://showhaus.app/hooks/stripe', body, { 'stripe-signature': good }), env, ctx());
  assert.deepEqual(await r1.json(), { ok: true, recorded: 'payment_succeeded', env: 'production', entitlement: 'owed', mailed: 'cloudflare' });
  const r2 = await worker.fetch(post('https://showhaus.app/hooks/stripe', body, { 'stripe-signature': good }), env, ctx());
  assert.equal((await r2.json()).duplicate, true);
  const ev1 = rows(env);
  assert.equal(ev1.length, 1);
  assert.deepEqual(JSON.parse(ev1[0].props), { stripe_type: 'checkout.session.completed', amount: 125000, currency: 'AUD', mode: 'payment', payment_link: 'plink_1' });
  assert.match(ev1[0].actor, /^c:[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(ev1).includes('buyer@'));
  assert.equal(await verifyStripe('whsec_test', good, body, t + 301), false, 'old signatures are refused');
  assert.equal(classify({ type: 'checkout.session.completed', data: { object: { payment_status: 'unpaid' } } }), 'payment_pending');
  assert.equal(classify({ type: 'checkout.session.expired', data: { object: {} } }), 'checkout_abandoned');
});

test('a redirect to Stripe Checkout is recorded as checkout_started (server-side)', async () => {
  const env = makeEnv();
  env.ASSETS = { fetch: async () => Response.redirect('https://buy.stripe.com/test_123', 302) };
  env.STUDIO_PAYMENT_LINK = 'https://buy.stripe.com/test_123'; // /pay/studio-pilot is served by src/studio.js
  const c = ctx();
  const r = await worker.fetch(new Request('https://map.lifeos.studio/pay/studio-pilot', { headers: { cookie: 'sh_a=b9', 'user-agent': 'Mozilla/5.0' } }), env, c);
  assert.equal(r.status, 302);
  await c.done();
  const [e] = rows(env);
  assert.equal(e.name, 'checkout_started'); assert.equal(e.env, 'test'); assert.match(e.actor, /^a:/);
});

test('ops read side refuses requests without a valid GitHub OIDC token', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(new Request('https://showhaus.app/api/ops/summary'), env, ctx())).status, 401);
  assert.equal((await worker.fetch(new Request('https://showhaus.app/api/ops/summary', { headers: { authorization: 'Bearer a.b.c' } }), env, ctx())).status, 401);
});

test('GitHub OIDC: signature, audience, repository and expiry are all checked', async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Date.now();
  const sign = async claims => {
    const h = b64({ alg: 'RS256', kid: 'k1' }), p = b64(claims);
    const s = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(h + '.' + p))).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const base = { iss: 'https://token.actions.githubusercontent.com', aud: 'showhaus-ops', exp: Math.floor(now / 1000) + 300, repository: 'in-c0/combinatory-venture-farming', repository_owner: 'in-c0' };
  const v = async c => verifyGithubOidc(await sign(c), { jwksOverride: [jwk], now });
  assert.ok(await v(base));
  assert.equal(await v({ ...base, aud: 'other' }), null);
  assert.equal(await v({ ...base, repository: 'someone/fork', repository_owner: 'someone' }), null);
  assert.equal(await v({ ...base, exp: Math.floor(now / 1000) - 1 }), null);
  const forged = (await sign(base)).replace(/\.[^.]+$/, '.' + Buffer.from('x').toString('base64url'));
  assert.equal(await verifyGithubOidc(forged, { jwksOverride: [jwk], now }), null);
});

test('journeys fold the anonymous visit into the account it became, money first', () => {
  const r = [
    { at: '1', name: 'view', actor: 'a:1' }, { at: '2', name: 'search', actor: 'a:1' },
    { at: '3', name: 'cta', actor: 'a:1', props: { cta: 'became:u:9' } }, { at: '3', name: 'signup', actor: 'u:9' },
    { at: '4', name: 'checkout_started', actor: 'u:9' },
    { at: '1', name: 'view', actor: 'a:2' },
  ];
  const j = buildJourneys(r);
  assert.equal(j.length, 1);
  assert.deepEqual(j[0].steps.map(s => s.name), ['view', 'search', 'signup', 'checkout_started']);
  assert.equal(funnelOf(r).view, 2);
});

test('health answers without a store binding (previews may have none)', async () => {
  const r = await worker.fetch(new Request('https://x.workers.dev/api/ops/health'), { ASSETS: { fetch: async () => new Response('') } }, ctx());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { store: false, mail_binding: false, mail_mode: null, webhook_secret: false, payment_link: false, mail_last_ok: null, mail_last_error: null, alert_last_ok: null, alert_last_error: null });
});

test('without a mail route, sign-in is hidden (me.available false) and start answers 503, never a silent failure', async () => {
  const env = makeEnv({ MAIL_SENDING: 'off' });
  const me = await (await worker.fetch(new Request('https://showhaus.app/api/auth/me'), env, ctx())).json();
  assert.deepEqual(me, { signedIn: false, available: false });
  const r = await worker.fetch(post('https://showhaus.app/api/auth/start', { email: 'z@example.com' }), env, ctx());
  assert.equal(r.status, 503); assert.equal(env.sent.length, 0);
});

test('Resend route is used when RESEND_API_KEY exists', async () => {
  const calls = [];
  const { sendCode } = await import('../src/ops/auth.js');
  await sendCode({ RESEND_API_KEY: 'k' }, 'a@example.com', '123456', async (url, init) => { calls.push([url, JSON.parse(init.body)]); return new Response('{"id":"x"}'); });
  assert.equal(calls[0][0], 'https://api.resend.com/emails');
  assert.deepEqual(calls[0][1].to, ['a@example.com']);
  assert.match(calls[0][1].subject, /^123456 /);
});

test('listing-kit beacons: kit slug and src kept, no actor without an id, bad slugs dropped', async () => {
  const env = makeEnv(), c = ctx();
  const send = body => worker.fetch(post('https://showhaus.app/api/e', body, { 'user-agent': 'Mozilla/5.0' }), env, c);
  assert.equal((await send({ name: 'view', path: '/p/', props: { kit: '4-17-flood-st-clovelly', utm_source: 'agent-4-17-flood-st-clovelly' } })).status, 204);
  assert.equal((await send({ name: 'cta', path: '/p/', props: { kit: '../etc', cta: 'explore' } })).status, 204);
  await c.done();
  const [a, b] = rows(env);
  assert.equal(a.actor, null);
  assert.deepEqual(JSON.parse(a.props), { utm_source: 'agent-4-17-flood-st-clovelly', kit: '4-17-flood-st-clovelly' });
  assert.deepEqual(JSON.parse(b.props), { cta: 'explore' });
});

test('payment → owner mail at once (production only), entitlement owed → refunded; replay never mails', async () => {
  const { recordStripeEvent } = await import('../src/ops/stripe.js');
  const env = makeEnv();
  const paid = { id: 'evt_p', type: 'checkout.session.completed', livemode: true, created: 1762590000, data: { object: { payment_intent: 'pi_1', amount_total: 125000, currency: 'aud', payment_status: 'paid', customer_details: { email: 'buyer@example.com' } } } };
  const r = await recordStripeEvent(env, paid);
  assert.deepEqual([r.body.entitlement, r.body.mailed], ['owed', 'cloudflare']);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].to, 'hello@showhaus.app');
  assert.match(env.sent[0].subject, /결제 성공 1,250\.00 AUD/);
  assert.ok(!JSON.stringify(env.sent).includes('buyer@'), 'no raw email in the alert');
  const refund = { id: 'evt_r', type: 'charge.refunded', livemode: true, data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 125000, currency: 'aud' } } };
  assert.equal((await recordStripeEvent(env, refund)).body.entitlement, 'refunded');
  assert.equal(env.sent.length, 2);
  const synth = await recordStripeEvent(env, { ...paid, id: 'evt_s', data: { object: { ...paid.data.object, payment_intent: 'pi_2' } } }, { forceEnv: 'synthetic' });
  assert.equal(synth.body.mailed, false); assert.equal(env.sent.length, 2);
  const { entitlementSummary, markEntitlement } = await import('../src/ops/owner.js');
  const d = env.OPS_DB;
  assert.deepEqual(await entitlementSummary(d), { owed: 0, delivered: 0, refunded: 1, disputed: 0, oldest_owed_at: null, owed_amount: 0 });
  await recordStripeEvent(env, { ...paid, id: 'evt_p3', data: { object: { ...paid.data.object, payment_intent: 'pi_3' } } });
  assert.equal((await entitlementSummary(d)).owed, 1);
  assert.equal((await markEntitlement(d, { id: 'pi_3', status: 'delivered' })).status, 200);
  assert.equal((await markEntitlement(d, { id: 'pi_1', status: 'delivered' })).status, 404, 'a refunded payment cannot be marked delivered');
  assert.equal((await entitlementSummary(d)).delivered, 1);
});

test('a failing mail route never fails the webhook; the error is visible in health', async () => {
  const { recordStripeEvent } = await import('../src/ops/stripe.js');
  const env = makeEnv({ MAIL: { send: async () => { throw new Error('not verified'); } } });
  const r = await recordStripeEvent(env, { id: 'evt_f', type: 'checkout.session.completed', livemode: true, data: { object: { payment_intent: 'pi_9', amount_total: 100, currency: 'aud', payment_status: 'paid' } } });
  assert.equal(r.status, 200); assert.equal(r.body.mailed, false);
  const h = await (await worker.fetch(new Request('https://showhaus.app/api/ops/health'), env, ctx())).json();
  assert.equal(h.alert_last_error, 'E');
});

test('one-tap "looks wrong" feedback is a page event with no free text', async () => {
  const env = makeEnv(), c = ctx();
  assert.equal((await worker.fetch(post('https://showhaus.app/api/e', { name: 'feedback', anon: 'b2', props: { kind: 'wrong', cta: 'rent', postcode: '2205', note: 'my address is 1 Foo St' } }, { 'user-agent': 'Mozilla/5.0' }), env, c)).status, 204);
  await c.done();
  const [r] = rows(env);
  assert.equal(r.name, 'feedback');
  assert.deepEqual(JSON.parse(r.props), { kind: 'wrong', cta: 'rent', postcode: '2205' });
});

test('server events mirror to PostHog only when opted in, pseudonymous, never for synthetic traffic', async () => {
  const { mirrorToPostHog } = await import('../src/ops/events.js');
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 200 }); };
  const ev = { name: 'checkout_started', actor: 'a:abc', env: 'production', source: 'server', path: '/pay/studio-pilot', props: { cta: 'x' }, at: '2026-11-08T12:00:00Z' };
  assert.equal(await mirrorToPostHog({}, ev, fake), false);
  assert.equal(await mirrorToPostHog({ POSTHOG_MIRROR: 'on' }, { ...ev, env: 'synthetic' }, fake), false);
  assert.equal(await mirrorToPostHog({ POSTHOG_MIRROR: 'on' }, ev, fake), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.event, 'sh_checkout_started');
  assert.equal(calls[0].body.distinct_id, 'a:abc');
  assert.equal(calls[0].body.properties.product, 'showhaus');
  assert.ok(!JSON.stringify(calls[0].body).includes('@'));
});

test('checkout carries the visitor PostHog id to Stripe and to the mirror, so the funnel joins one person', async () => {
  const env = makeEnv();
  env.STUDIO_PAYMENT_LINK = 'https://buy.stripe.com/test_123';
  const phCookie = 'ph_phc_z7qYzteR85WcVGvZjZLVAH6v7VM42Z3ik4WU8dBMfTVJ_posthog=' + encodeURIComponent(JSON.stringify({ distinct_id: '019f7-abc_D' }));
  const c = ctx();
  const r = await worker.fetch(new Request('https://map.lifeos.studio/pay/studio-pilot', { headers: { cookie: 'sh_a=b9; ' + phCookie, 'user-agent': 'Mozilla/5.0' } }), env, c);
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('location')).searchParams.get('client_reference_id'), '019f7-abc_D');
  await c.done();
  // Without the cookie the redirect is untouched.
  const r2 = await worker.fetch(new Request('https://map.lifeos.studio/pay/studio-pilot', { headers: { 'user-agent': 'Mozilla/5.0' } }), env, ctx());
  assert.equal(r2.headers.get('location'), 'https://buy.stripe.com/test_123');
  const { mirrorToPostHog } = await import('../src/ops/events.js');
  const calls = [];
  const fake = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); };
  await mirrorToPostHog({ POSTHOG_MIRROR: 'on' }, { name: 'payment_succeeded', actor: 'c:x', ph: '019f7-abc_D', env: 'production' }, fake);
  assert.equal(calls[0].distinct_id, '019f7-abc_D');
});

test('Pro: an email in the PRO_EMAILS secret becomes Pro at sign-in; others do not; the email is never stored', async () => {
  const env = makeEnv({ PRO_EMAILS: ' Owner@Example.com ,x@y.co' });
  const signIn = async email => {
    await worker.fetch(post('https://showhaus.app/api/auth/start', { email }, { 'user-agent': 'Mozilla/5.0' }), env, ctx());
    const code = env.sent.at(-1).subject.slice(0, 6);
    const ok = await worker.fetch(post('https://showhaus.app/api/auth/verify', { email, code }, { 'user-agent': 'Mozilla/5.0' }), env, ctx());
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    return { verify: await ok.json(), me: await (await worker.fetch(new Request('https://showhaus.app/api/auth/me', { headers: { cookie } }), env, ctx())).json() };
  };
  const owner = await signIn('owner@example.com');
  assert.equal(owner.verify.pro, true); assert.equal(owner.me.pro, true);
  const other = await signIn('someone@example.com');
  assert.equal(other.verify.pro, false); assert.equal(other.me.pro, false);
  const anon = await (await worker.fetch(new Request('https://showhaus.app/api/auth/me'), env, ctx())).json();
  assert.equal(anon.pro, undefined);
  assert.ok(!JSON.stringify(env.OPS_DB._db.prepare('SELECT * FROM sh_pro').all()).includes('example.com'));
});

test('Pro grant route refuses requests without a valid GitHub OIDC token', async () => {
  const env = makeEnv();
  const r = await worker.fetch(post('https://showhaus.app/api/ops/pro', { email: 'a@b.co' }), env, ctx());
  assert.equal(r.status, 401);
  assert.equal(env.OPS_DB._db.prepare("SELECT name FROM sqlite_master WHERE name = 'sh_pro'").all().length <= 1, true);
});

test('channelsOf groups real arrivals by utm_source, then referrer host, then direct', () => {
  const rows = [
    { name: 'view', actor: 'a', props: { utm_source: 'guide', utm_medium: 'blog', utm_campaign: 'winter-sun-2026' } },
    { name: 'view', actor: 'b', props: { utm_source: 'guide', utm_medium: 'blog', utm_campaign: 'winter-sun-2026' } },
    { name: 'view', actor: 'a', props: { utm_source: 'guide', utm_medium: 'blog', utm_campaign: 'winter-sun-2026' } },
    { name: 'view', actor: 'c', props: { ref: 'www.google.com' } },
    { name: 'view', actor: null, props: null },
    { name: 'search', actor: 'a', props: { utm_source: 'guide' } },
  ];
  const out = channelsOf(rows);
  assert.deepEqual(out[0], { source: 'guide', medium: 'blog', campaign: 'winter-sun-2026', views: 3, visitors: 2 });
  assert.deepEqual(out.map(c => c.source).sort(), ['direct', 'guide', 'www.google.com']);
});
