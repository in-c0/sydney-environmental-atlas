import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, planById, priceLabel, proLink, cleanStart, handlePro } from '../src/subscribe.js';
import { classify } from '../src/ops/stripe.js';
import { SERVER_EVENTS, ALERT_EVENTS } from '../src/ops/events.js';
import { form, writeLinks, WEBHOOK_EVENTS } from './showhaus-stripe-setup.mjs';

test('plans: three, AUD monthly, agency is 500', () => {
  assert.deepEqual(PLANS.map(p => p.id), ['agent', 'agency', 'builder']);
  assert.equal(priceLabel(planById('agency')), 'AUD 500 a month');
  assert.equal(priceLabel(planById('agent')), 'AUD 149 a month');
});

test('proLink accepts only https Stripe hosts', () => {
  assert.equal(proLink({ PRO_LINK_AGENCY: 'https://buy.stripe.com/abc' }, 'agency'), 'https://buy.stripe.com/abc');
  assert.equal(proLink({ PRO_LINK_AGENCY: 'https://evil.example/abc' }, 'agency'), null);
  assert.equal(proLink({ PRO_LINK_AGENCY: 'http://buy.stripe.com/abc' }, 'agency'), null);
  assert.equal(proLink({}, 'agent'), null);
});

test('cleanStart validates the free-listing request', () => {
  assert.equal(cleanStart({}).ok, false);
  assert.match(cleanStart({ company: 'X' }).error, /work email/);
  assert.match(cleanStart({ company: 'X', email: 'a@b.com.au' }).error, /listing address/);
  const ok = cleanStart({ company: ' Acme Realty <b> ', email: 'Sales@Acme.com.au', listing: '1 Test St, Randwick', plan: 'nope', src: 'mail/1?' });
  assert.equal(ok.ok, true);
  assert.equal(ok.row.plan, 'agency');
  assert.equal(ok.row.email, 'sales@acme.com.au');
  assert.equal(ok.row.company.includes('<'), false);
  assert.equal(ok.row.src, 'mail1');
  assert.equal(cleanStart({ company: 'X', email: 'x@gmail.com', plan_url: 'https://example.com/plan.pdf' }).row.free_mail, true);
  assert.equal(cleanStart({ company: 'X', email: 'x@y.com', plan_url: 'javascript:alert(1)' }).ok, false);
});

test('/pay/pro without a link falls back to the free-listing form; with one it redirects to Stripe', async () => {
  let r = await handlePro(new Request('https://showhaus.app/pay/pro?plan=builder&src=mail-1'), {}, null);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://showhaus.app/pro/?plan=builder&src=mail-1#start');
  r = await handlePro(new Request('https://showhaus.app/pay/pro?plan=agency'), { PRO_LINK_AGENCY: 'https://buy.stripe.com/x1' }, null);
  assert.equal(r.headers.get('location'), 'https://buy.stripe.com/x1');
  r = await handlePro(new Request('https://x.workers.dev/pay/pro?plan=zzz'), {}, null);
  assert.equal(r.headers.get('location'), 'https://x.workers.dev/showhaus/pro/?plan=agency&src=direct#start');
});

test('/api/pro-config lists plans and which are payable', async () => {
  const r = await handlePro(new Request('https://showhaus.app/api/pro-config'), { PRO_LINK_AGENT: 'https://buy.stripe.com/a' }, null);
  const j = await r.json();
  assert.deepEqual(j.plans.map(p => p.payable), [true, false, false]);
  assert.equal(j.contact, 'hello@showhaus.app');
});

test('/api/pro/start without a store answers 503 with a way out', async () => {
  const r = await handlePro(new Request('https://showhaus.app/api/pro/start', { method: 'POST', body: '{}' }), {}, null);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /hello@showhaus.app/);
});

test('stripe classify: subscription lifecycle', () => {
  assert.equal(classify({ type: 'customer.subscription.created', data: { object: {} } }), 'subscription_started');
  assert.equal(classify({ type: 'customer.subscription.deleted', data: { object: {} } }), 'subscription_cancelled');
  assert.equal(classify({ type: 'invoice.paid', data: { object: { billing_reason: 'subscription_cycle' } } }), 'subscription_renewed');
  assert.equal(classify({ type: 'invoice.paid', data: { object: { billing_reason: 'subscription_create' } } }), null);
  assert.equal(classify({ type: 'invoice.payment_failed', data: { object: {} } }), 'payment_failed');
  assert.equal(classify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', mode: 'subscription' } } }), 'payment_succeeded');
  for (const n of ['pro_start', 'subscription_started', 'subscription_renewed', 'subscription_cancelled']) assert.ok(SERVER_EVENTS.has(n), n);
  assert.ok(ALERT_EVENTS.has('pro_start'));
});

test('setup script: form encoding, wrangler vars rewrite, webhook events match the classifier', () => {
  assert.equal(form({ a: { b: 1 }, c: [{ d: 'x' }] }).toString(), 'a%5Bb%5D=1&c%5B0%5D%5Bd%5D=x');
  const src = '{\n  "vars": { "POSTHOG_MIRROR": "on" },\n}';
  const once = writeLinks(src, { agency: 'https://buy.stripe.com/1' });
  assert.match(once, /"PRO_LINK_AGENCY": "https:\/\/buy.stripe.com\/1"/);
  const twice = writeLinks(once, { agency: 'https://buy.stripe.com/2' });
  assert.equal((twice.match(/PRO_LINK_AGENCY/g) || []).length, 1);
  assert.match(twice, /buy.stripe.com\/2/);
  for (const t of WEBHOOK_EVENTS) assert.notEqual(classify({ type: t, data: { object: { payment_status: 'paid', billing_reason: 'subscription_cycle' } } }), null, t);
});
