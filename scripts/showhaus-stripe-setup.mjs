#!/usr/bin/env node
// One-time (idempotent) Stripe setup for SHOWHAUS Pro monthly plans, run wherever STRIPE_SECRET_KEY already exists
// (the owner's PC .env files listed in Project-harness INFRA.md). Nothing secret is printed or written to git.
//
//   STRIPE_SECRET_KEY=sk_live_... node scripts/showhaus-stripe-setup.mjs            # dry run: shows what it would do
//   STRIPE_SECRET_KEY=sk_live_... node scripts/showhaus-stripe-setup.mjs --apply    # creates/reuses, then:
//     1. product "SHOWHAUS Pro" + one monthly AUD price per plan in src/subscribe.js PLANS (lookup_key showhaus_pro_<id>)
//     2. one Payment Link per price (subscription mode, promotion codes on, redirect to showhaus.app/pro/?welcome=<id>)
//     3. a webhook endpoint https://showhaus.app/hooks/stripe for the events src/ops/stripe.js classifies
//     4. writes the three public link URLs into wrangler.jsonc vars PRO_LINK_<ID> (commit + push → Workers Builds deploys)
//     5. with --put-secret: pipes the new webhook signing secret into `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
//        (only when the endpoint was created now; Stripe shows a signing secret once — an existing endpoint keeps its own).
// --env <file> reads STRIPE_SECRET_KEY from a .env file instead of the environment.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PLANS } from '../src/subscribe.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply'), PUT_SECRET = args.includes('--put-secret');
const envFile = args.includes('--env') ? args[args.indexOf('--env') + 1] : null;
const WEBHOOK_URL = 'https://showhaus.app/hooks/stripe';
export const WEBHOOK_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'checkout.session.expired', 'payment_intent.payment_failed', 'charge.refunded', 'charge.dispute.created',
  'customer.subscription.created', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];

function keyFrom() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  if (envFile) { const m = readFileSync(envFile, 'utf8').match(/^\s*STRIPE_SECRET_KEY\s*=\s*"?([^"\s]+)"?/m); if (m) return m[1]; }
  return null;
}

// Stripe's form encoding for nested params: { a: { b: 1 }, c: [x] } → a[b]=1&c[0]=x
export function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [i, x])) : v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function api(key, method, path, body) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20' },
    body: body ? form(body).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error?.message || r.status}`);
  return j;
}

export function writeLinks(text, links) {
  // Adds or replaces "PRO_LINK_<ID>": "<url>" inside the vars object, keeping comments and the rest of the file.
  let out = text;
  for (const [id, url] of Object.entries(links)) {
    const k = 'PRO_LINK_' + id.toUpperCase(), re = new RegExp(`"${k}"\\s*:\\s*"[^"]*"`);
    out = re.test(out) ? out.replace(re, `"${k}": "${url}"`) : out.replace(/"vars"\s*:\s*\{/, m => `${m} "${k}": "${url}",`);
  }
  return out;
}

async function main() {
  const key = keyFrom();
  if (!key) { console.error('No STRIPE_SECRET_KEY (env or --env <file>). Nothing done.'); process.exit(2); }
  console.log(`Stripe ${key.startsWith('sk_live') || key.startsWith('rk_live') ? 'LIVE' : 'TEST'} mode · ${APPLY ? 'apply' : 'dry run'}`);
  const products = await api(key, 'GET', '/products/search?query=' + encodeURIComponent("metadata['showhaus']:'pro'"));
  let product = products.data[0];
  if (!product && APPLY) product = await api(key, 'POST', '/products', { name: 'SHOWHAUS Pro', description: '3D walks from floor plans for NSW agencies and builders', metadata: { showhaus: 'pro' }, statement_descriptor: 'SHOWHAUS PRO' });
  console.log('product', product ? product.id : '(would create)');
  const links = {};
  for (const p of PLANS) {
    const lk = 'showhaus_pro_' + p.id;
    const found = (await api(key, 'GET', '/prices?active=true&lookup_keys[0]=' + lk)).data[0];
    let price = found && found.unit_amount === p.amount && found.currency === 'aud' ? found : null;
    if (!price && APPLY) price = await api(key, 'POST', '/prices', { product: product.id, currency: 'aud', unit_amount: p.amount, recurring: { interval: 'month' }, lookup_key: lk, transfer_lookup_key: true, tax_behavior: 'inclusive', nickname: `SHOWHAUS Pro ${p.name}`, metadata: { showhaus_plan: p.id } });
    console.log('price', p.id, price ? price.id : '(would create)', p.amount / 100, 'AUD/month');
    if (!price) continue;
    const existing = (await api(key, 'GET', '/payment_links?active=true&limit=100')).data.find(l => l.metadata?.showhaus_plan === p.id && l.metadata?.price === price.id);
    let link = existing;
    if (!link && APPLY) link = await api(key, 'POST', '/payment_links', {
      line_items: [{ price: price.id, quantity: 1 }], allow_promotion_codes: true, billing_address_collection: 'auto',
      subscription_data: { metadata: { showhaus_plan: p.id } }, metadata: { showhaus_plan: p.id, price: price.id },
      after_completion: { type: 'redirect', redirect: { url: `https://showhaus.app/pro/?welcome=${p.id}` } },
    });
    if (link) links[p.id] = link.url;
    console.log('link', p.id, link ? link.url : '(would create)');
  }
  const hooks = (await api(key, 'GET', '/webhook_endpoints?limit=100')).data;
  let hook = hooks.find(h => h.url === WEBHOOK_URL), secret = null;
  if (hook && APPLY) {
    const missing = WEBHOOK_EVENTS.filter(e => !hook.enabled_events.includes(e) && !hook.enabled_events.includes('*'));
    if (missing.length) { await api(key, 'POST', '/webhook_endpoints/' + hook.id, { enabled_events: [...new Set([...hook.enabled_events, ...WEBHOOK_EVENTS])] }); console.log('webhook events added', missing.join(',')); }
  }
  if (!hook && APPLY) { hook = await api(key, 'POST', '/webhook_endpoints', { url: WEBHOOK_URL, enabled_events: WEBHOOK_EVENTS, description: 'SHOWHAUS Worker (src/ops/stripe.js)' }); secret = hook.secret; }
  console.log('webhook', hook ? hook.id : '(would create)', secret ? '(new signing secret held in memory)' : '');
  if (APPLY && Object.keys(links).length) {
    const f = new URL('../wrangler.jsonc', import.meta.url);
    writeFileSync(f, writeLinks(readFileSync(f, 'utf8'), links));
    console.log('wrangler.jsonc vars updated:', Object.keys(links).map(id => 'PRO_LINK_' + id.toUpperCase()).join(', '), '→ commit + push to deploy');
  }
  if (secret && PUT_SECRET) {
    const r = spawnSync('npx', ['wrangler', 'secret', 'put', 'STRIPE_WEBHOOK_SECRET', '--name', 'sydney-environmental-atlas'], { input: secret, stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    console.log('STRIPE_WEBHOOK_SECRET', r.status === 0 ? 'set on the Worker' : 'NOT set (wrangler exit ' + r.status + ')');
  } else if (secret) console.log('Re-run is not enough to recover this secret: pass --put-secret on the run that creates the endpoint, or roll it in the Stripe dashboard.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('showhaus-stripe-setup.mjs')) main().catch(e => { console.error(e.message); process.exit(1); });
