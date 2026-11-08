// Routes for SHOWHAUS operations, served on every host (showhaus.app, previews, workers.dev):
//   /api/e            page beacons            /api/auth/*        email-code sign-up / log-in
//   /hooks/stripe     Stripe webhook          /api/ops/health    public booleans
//   /api/ops/summary  CVF read side (OIDC)    /api/ops/replay    CVF webhook replay (OIDC, synthetic)
import { handleBeacon, track, environmentOf } from './events.js';
import { handleAuth, currentUser, cookieOf } from './auth.js';
import { handleStripeHook } from './stripe.js';
import { requireOps } from './oidc.js';
import { summary, replay, health, entitlement } from './summary.js';
import { db, pseudo } from './store.js';

const sameOrigin = request => {
  const o = request.headers.get('origin');
  if (!o) return true;
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
};

export async function handleOps(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (!(path === '/api/e' || path.startsWith('/api/auth/') || path === '/hooks/stripe' || path.startsWith('/api/ops/'))) return null;
  try {
    if (path === '/hooks/stripe') return await handleStripeHook(request, env);
    if (request.method === 'POST' && path !== '/api/ops/replay' && path !== '/api/ops/entitlement' && !sameOrigin(request)) return new Response('forbidden', { status: 403 });
    if (path === '/api/e') {
      if (request.method !== 'POST') return new Response('method', { status: 405 });
      const user = await currentUser(request, env).catch(() => null);
      return await handleBeacon(request, env, ctx, { userId: user?.id });
    }
    if (path.startsWith('/api/auth/')) return await handleAuth(request, env, path);
    if (path === '/api/ops/health') return Response.json(await health(env), { headers: { 'cache-control': 'no-store' } });
    if (!(await requireOps(request))) return new Response('unauthorized', { status: 401 });
    if (path === '/api/ops/summary') return await summary(request, env);
    if (path === '/api/ops/replay' && request.method === 'POST') return await replay(request, env);
    if (path === '/api/ops/entitlement' && request.method === 'POST') return await entitlement(request, env);
    return new Response('not found', { status: 404 });
  } catch (e) {
    console.error('ops', path, e && e.stack || e);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

// posthog-js keeps the visitor's PostHog id in the ph_<key>_posthog cookie. Sending server events under that id
// joins them to the same person's pageviews, so the PostHog funnel visit -> checkout -> paid connects.
export function posthogIdOf(request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)ph_phc_[A-Za-z0-9]+_posthog=([^;]+)/);
  if (!m) return null;
  try { const id = JSON.parse(decodeURIComponent(m[1])).distinct_id; return typeof id === 'string' && id.length <= 200 ? id : null; } catch { return null; }
}

export const REF_OK = /^[A-Za-z0-9_-]{1,200}$/; // Stripe client_reference_id charset
const CHECKOUT_HOSTS = /(^|\.)(buy|checkout)\.stripe\.com$/;
// Any route that redirects a visitor to Stripe Checkout counts as checkout_started (server-observed, so
// a page cannot fake it). Works for /pay/* routes owned elsewhere in the Worker without touching them.
// Returns a replacement redirect when it can tag a Payment Link with the visitor's PostHog id
// (client_reference_id), so the webhook's payment_succeeded joins the same PostHog person; otherwise undefined.
export function observeCheckout(request, response, env, ctx) {
  try {
    if (!(response.status >= 300 && response.status < 400)) return;
    const loc = response.headers.get('location');
    if (!loc || !CHECKOUT_HOSTS.test(new URL(loc).hostname)) return;
    const path = new URL(request.url).pathname;
    const ph = posthogIdOf(request);
    ctx.waitUntil((async () => {
      const d = await db(env); if (!d) return;
      const user = await currentUser(request, env).catch(() => null);
      const anon = cookieOf(request, 'sh_a');
      const actor = user ? 'u:' + user.id : anon ? 'a:' + await pseudo(d, 'anon', anon.slice(0, 64)) : null;
      const synthetic = new URL(request.url).searchParams.get('synthetic') === '1';
      await track(env, { name: 'checkout_started', env: environmentOf(request, { claimed: synthetic ? 'synthetic' : undefined }), source: 'server', actor, ph, path, props: { cta: path.slice(0, 60) } });
    })().catch(e => console.error('observeCheckout', e)));
    const to = new URL(loc);
    if (ph && REF_OK.test(ph) && to.hostname === 'buy.stripe.com' && !to.searchParams.has('client_reference_id')) {
      to.searchParams.set('client_reference_id', ph);
      const headers = new Headers(response.headers); headers.set('location', to.toString());
      return new Response(null, { status: response.status, headers });
    }
  } catch { /* never break the redirect */ }
}
