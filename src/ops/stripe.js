// POST /hooks/stripe — Stripe webhook. Signature-verified with the Worker secret STRIPE_WEBHOOK_SECRET.
// Until that secret exists the endpoint answers 503 'webhook secret not set' (so a misconfigured endpoint is
// visible to Stripe's delivery log and to CVF's E2E), and nothing is recorded.
// Records PII-free events only: amount, currency, mode, payment link id, pseudonymous customer.
import { db, pseudo, setMeta } from './store.js';
import { track } from './events.js';

const TOLERANCE_S = 300;
const enc = new TextEncoder();

export function parseSigHeader(h) {
  const out = { t: null, v1: [] };
  for (const part of String(h || '').split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') out.t = Number(v);
    if (k === 'v1' && v) out.v1.push(v.trim());
  }
  return out;
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
export async function stripeSignature(secret, t, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
}
export async function verifyStripe(secret, header, payload, nowS = Math.floor(Date.now() / 1000)) {
  const { t, v1 } = parseSigHeader(header);
  if (!t || !v1.length || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const want = await stripeSignature(secret, t, payload);
  return v1.some(s => safeEq(s, want));
}

// Stripe event → our event name (null = ignored).
export function classify(e) {
  const o = e?.data?.object || {};
  switch (e?.type) {
    case 'checkout.session.completed': return o.payment_status === 'paid' || o.payment_status === 'no_payment_required' ? 'payment_succeeded' : 'payment_pending';
    case 'checkout.session.async_payment_succeeded': return 'payment_succeeded';
    case 'checkout.session.async_payment_failed': case 'payment_intent.payment_failed': return 'payment_failed';
    case 'checkout.session.expired': return 'checkout_abandoned';
    case 'charge.refunded': return 'refund';
    case 'charge.dispute.created': return 'dispute';
    default: return null;
  }
}

// Shared by the signed webhook and CVF's authenticated replay (which forces environment = synthetic).
export async function recordStripeEvent(env, e, { forceEnv } = {}) {
  const d = await db(env);
  if (!d) return { status: 503, body: { error: 'store not bound' } };
  const name = classify(e);
  if (!e?.id) return { status: 400, body: { error: 'no event id' } };
  const seen = await d.prepare('INSERT OR IGNORE INTO sh_hooks_seen (id, at) VALUES (?, ?)').bind(String(e.id), new Date().toISOString()).run();
  if (!seen.meta?.changes) return { status: 200, body: { ok: true, duplicate: true } };
  if (!name) return { status: 200, body: { ok: true, ignored: e.type } };
  const o = e.data.object || {};
  const environment = forceEnv || (e.livemode ? 'production' : 'test');
  const who = o.customer || o.customer_details?.email || o.receipt_email || null;
  const props = {
    stripe_type: e.type,
    amount: o.amount_total ?? o.amount_received ?? o.amount_refunded ?? o.amount ?? null,
    currency: (o.currency || '').toUpperCase() || null,
    mode: o.mode || null,
    payment_link: typeof o.payment_link === 'string' ? o.payment_link : null,
    failure: o.last_payment_error?.code || o.failure_code || null,
  };
  for (const k of Object.keys(props)) if (props[k] == null) delete props[k];
  await track(env, { name, env: environment, source: 'stripe', actor: who ? 'c:' + await pseudo(d, 'customer', who) : null, path: '/hooks/stripe', props, at: e.created ? new Date(e.created * 1000).toISOString() : undefined });
  await setMeta(d, 'stripe_last_event_at', new Date().toISOString());
  return { status: 200, body: { ok: true, recorded: name, env: environment } };
}

export async function handleStripeHook(request, env) {
  if (request.method !== 'POST') return new Response('method', { status: 405 });
  if (!env.STRIPE_WEBHOOK_SECRET) return Response.json({ error: 'webhook secret not set' }, { status: 503 });
  const payload = await request.text();
  if (!(await verifyStripe(env.STRIPE_WEBHOOK_SECRET, request.headers.get('stripe-signature'), payload))) {
    return Response.json({ error: 'bad signature' }, { status: 400 });
  }
  let e; try { e = JSON.parse(payload); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const r = await recordStripeEvent(env, e);
  return Response.json(r.body, { status: r.status });
}
