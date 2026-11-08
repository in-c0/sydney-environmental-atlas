// SHOWHAUS Studio routes (every host, so previews and workers.dev behave like showhaus.app):
//   GET /pay/studio-pilot    302 → STUDIO_PAYMENT_LINK (Stripe Payment Link). The Worker's observeCheckout (src/ops) records
//                            that redirect as checkout_started, server-side. Without a link: logs a `cta` event and lands on
//                            the pilot page's reserve section, so the button always works.
//   GET /api/studio-config   { payment: bool, contact: string|null } for the pilot page.
// Page beacons go to the one /api/e (src/ops/events.js), which owns the event contract.
import { track, environmentOf } from './ops/events.js';

const PAY_HOSTS = /^(buy|checkout)\.stripe\.com$/;

export function paymentLink(env) {
  const raw = (env && env.STUDIO_PAYMENT_LINK) || '';
  try { const u = new URL(raw); return u.protocol === 'https:' && PAY_HOSTS.test(u.hostname) ? u.toString() : null; } catch { return null; }
}

export function fallbackUrl(url) {
  const onShowhaus = url.hostname === 'showhaus.app' || url.hostname === 'www.showhaus.app';
  return `${url.origin}${onShowhaus ? '' : '/showhaus'}/studio/pilot.html?reserve=1#reserve`;
}

export async function handleStudio(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/pay/studio-pilot') {
    const link = paymentLink(env);
    if (!link) {
      const src = (url.searchParams.get('src') || 'direct').replace(/[^\w.-]/g, '').slice(0, 60);
      const p = track(env, { name: 'cta', env: environmentOf(request), source: 'server', actor: null, path, props: { cta: 'studio-pilot-reserve', utm_source: src } }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    }
    return new Response(null, { status: 302, headers: { location: link || fallbackUrl(url), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  if (path === '/api/studio-config') {
    const contact = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test((env && env.STUDIO_CONTACT_EMAIL) || '') ? env.STUDIO_CONTACT_EMAIL : null;
    return Response.json({ payment: !!paymentLink(env), contact }, { headers: { 'cache-control': 'no-store' } });
  }
  return null;
}
