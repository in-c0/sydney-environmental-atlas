// SHOWHAUS Studio routes (every host, so previews and workers.dev behave like showhaus.app):
//   GET  /pay/studio-pilot     logs checkout_start, then 302 → STUDIO_PAYMENT_LINK (Stripe Payment Link) or the reserve fallback
//   GET  /api/studio-config    { payment: bool, contact: string|null } for the pilot page
//   POST /api/e                page beacons → Workers Analytics Engine (binding EVENTS). No cookies, no IP, no personal data.
// If another /api/e handler runs earlier in the Worker (src/ops), it wins and this one is never reached.

const STUDIO_EVENTS = new Set(['view', 'play', 'floor', 'embed_copy', 'checkout_start', 'cta']);
const PAY_HOSTS = /^(buy|checkout)\.stripe\.com$/;
const clip = (v, n = 60) => (v == null ? '' : String(v).replace(/[^\w.:/@ -]/g, '').slice(0, n));

export function paymentLink(env) {
  const raw = (env && env.STUDIO_PAYMENT_LINK) || '';
  try { const u = new URL(raw); return u.protocol === 'https:' && PAY_HOSTS.test(u.hostname) ? u.toString() : null; } catch { return null; }
}

// One data point per event. blobs: name, project, src, building, environment. doubles: level, embed, auto. index: project.
export function eventPoint(ev, environment) {
  const name = clip(ev.e ?? ev.name, 24);
  if (!STUDIO_EVENTS.has(name)) return null;
  const props = ev.props || {};
  const p = clip(ev.p ?? props.kind, 40), src = clip(ev.src ?? props.utm_source ?? props.cta, 60), b = clip(ev.b ?? props.step, 4);
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : -1);
  return { blobs: [name, p, src, b, environment], doubles: [num(ev.l), num(ev.embed), num(ev.auto)], indexes: [p || 'none'] };
}

const SYNTHETIC_UA = /cvf-e2e|cvf-promise-probe|headlesschrome|playwright|bot\b|crawler|spider|preview/i;
function environmentOf(request) {
  const host = new URL(request.url).hostname, ua = request.headers.get('user-agent') || '';
  if (request.headers.get('x-cvf-synthetic') === '1' || SYNTHETIC_UA.test(ua)) return 'synthetic';
  return host === 'showhaus.app' || host === 'www.showhaus.app' ? 'production' : 'test';
}

function write(env, point) {
  try { if (point && env && env.EVENTS && typeof env.EVENTS.writeDataPoint === 'function') { env.EVENTS.writeDataPoint(point); return true; } } catch { /* never break a page */ }
  return false;
}

export async function handleStudio(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/pay/studio-pilot') {
    const link = paymentLink(env);
    write(env, eventPoint({ e: 'checkout_start', p: 'studio-pilot', src: url.searchParams.get('src') || 'direct', auto: link ? 1 : 0 }, environmentOf(request)));
    return new Response(null, { status: 302, headers: { location: link || fallbackUrl(url), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  if (path === '/api/studio-config') {
    const contact = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test((env && env.STUDIO_CONTACT_EMAIL) || '') ? env.STUDIO_CONTACT_EMAIL : null;
    return Response.json({ payment: !!paymentLink(env), contact }, { headers: { 'cache-control': 'no-store' } });
  }
  if (path === '/api/e') {
    if (request.method !== 'POST') return new Response('method', { status: 405 });
    const origin = request.headers.get('origin');
    if (origin) { try { if (new URL(origin).host !== url.host) return new Response('forbidden', { status: 403 }); } catch { return new Response('forbidden', { status: 403 }); } }
    let body = {};
    try { const text = await request.text(); if (text.length > 2048) return new Response('too large', { status: 413 }); body = JSON.parse(text || '{}'); } catch { return new Response('bad json', { status: 400 }); }
    const point = eventPoint(body, environmentOf(request));
    if (!point) return new Response('unknown event', { status: 400 });
    write(env, point);
    return new Response(null, { status: 204 });
  }
  return null;
}

// Without a payment link the button still works: it lands on the pilot page's reserve section.
export function fallbackUrl(url) {
  const onShowhaus = url.hostname === 'showhaus.app' || url.hostname === 'www.showhaus.app';
  return `${url.origin}${onShowhaus ? '' : '/showhaus'}/studio/pilot.html?reserve=1#reserve`;
}
