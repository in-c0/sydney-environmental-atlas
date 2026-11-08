// Event contract (CVF spec DECISION-2026-11-08 §3). One row per event: name, environment
// (production | test | synthetic), source (client | server | stripe), pseudonymous actor, path, small props.
// Never stored: raw email, IP, query strings, payment details.
import { db, insertEvent, pseudo } from './store.js';

// Events a browser may send. Account and money events are server-only, so a page cannot forge them.
export const CLIENT_EVENTS = new Set(['view', 'search', 'place_card', 'pro_interest', 'signin_open', 'cta']);
export const SERVER_EVENTS = new Set(['signup', 'login', 'logout', 'checkout_started', 'checkout_abandoned',
  'payment_succeeded', 'payment_failed', 'payment_pending', 'refund', 'dispute']);
// Events that page the owner during a sprint (CVF polls them; see /api/ops/summary).
export const ALERT_EVENTS = new Set(['checkout_started', 'payment_succeeded', 'payment_failed', 'dispute']);

const BOT_UA = /cvf-e2e|cvf-promise-probe|headlesschrome|playwright|bot\b|crawler|spider|slurp|facebookexternalhit|preview/i;
const PROD_HOSTS = new Set(['showhaus.app', 'www.showhaus.app']);

// Production only on the real host and only for traffic that does not mark itself as a probe.
// A request can downgrade itself to synthetic, never upgrade test → production.
export function environmentOf(request, { claimed } = {}) {
  const host = new URL(request.url).hostname;
  const ua = request.headers.get('user-agent') || '';
  if (request.headers.get('x-cvf-synthetic') === '1' || claimed === 'synthetic' || BOT_UA.test(ua)) return 'synthetic';
  return PROD_HOSTS.has(host) ? 'production' : 'test';
}

const clip = (v, n = 80) => (v == null ? undefined : String(v).slice(0, n));
const cleanPath = p => { try { return new URL(p, 'https://x').pathname.slice(0, 120); } catch { return null; } };
function cleanProps(name, p = {}) {
  const out = {};
  for (const k of ['step', 'plan', 'lens', 'kind', 'cta', 'utm_source', 'utm_medium', 'utm_campaign']) if (p[k] != null) out[k] = clip(p[k], 60);
  if (p.ref) { try { out.ref = new URL(p.ref).hostname.slice(0, 80); } catch { /* not a URL: drop */ } }
  if (p.postcode != null && /^\d{4}$/.test(String(p.postcode))) out.postcode = String(p.postcode); // area, not a person
  if (p.kit != null && /^[a-z0-9-]{3,80}$/.test(String(p.kit))) out.kit = String(p.kit); // listing-kit slug = a street address page, not a person
  return Object.keys(out).length ? out : undefined;
}

// Record an event decided by the server (signup, login, checkout_started, webhook outcomes).
export async function track(env, ev) {
  const d = await db(env);
  if (!d) return false;
  await insertEvent(d, { ...ev, at: ev.at || new Date().toISOString() });
  return true;
}

// POST /api/e — beacon from the page. Body: { name, anon?, path?, env?: 'synthetic', props? }.
export async function handleBeacon(request, env, ctx, { userId } = {}) {
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return new Response('bad json', { status: 400 }); }
  if (!CLIENT_EVENTS.has(body.name)) return new Response('unknown event', { status: 400 });
  const d = await db(env);
  if (!d) return new Response(null, { status: 204, headers: { 'x-ops': 'store-unbound' } });
  const environment = environmentOf(request, { claimed: body.env });
  // Signed-in visitors are identified by their account pseudonym, others by a random per-browser id.
  const actor = userId ? 'u:' + userId : body.anon ? 'a:' + await pseudo(d, 'anon', clip(body.anon, 64)) : null;
  ctx.waitUntil(insertEvent(d, { name: body.name, env: environment, source: 'client', actor, path: cleanPath(body.path || '/'), props: cleanProps(body.name, body.props) }));
  return new Response(null, { status: 204 });
}
