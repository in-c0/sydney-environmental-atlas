// SHOWHAUS listing routes (every host; on showhaus.app the paths are at the root, elsewhere under /showhaus/):
//   GET /l/<slug>          one listing page (dist/showhaus/l/index.html reads /l/data/<slug>.json)
//   GET /l/<slug>/claim    the claim flow for that listing (dist/showhaus/claim/, slug passed as ?p=)
//   GET /agent, /agency    read-only views over the same listings (one page, dist/showhaus/agent/, reads its role from the path)
//   GET /p/?a=<slug>       301 → /l/<slug>       (old listing-kit links)
//   GET /studio/?p=<slug>  301 → /l/<slug>       (old studio links; ?embed=1 and /studio/pilot.html are kept as they were)
// Slugs are checked against dist/showhaus/data/listings.json, so a typo answers 404 instead of an empty page.
// The page assets keep their own paths (/l/index.html, /l/data/…, /claim/…), so this module only maps the pretty URLs.

const SLUG = /^[a-z0-9-]{3,80}$/;
const SHOWHAUS_HOSTS = new Set(['showhaus.app', 'www.showhaus.app']);

const onShowhaus = url => SHOWHAUS_HOSTS.has(url.hostname);
const base = url => (onShowhaus(url) ? '' : '/showhaus');
// Path seen by the app: '/l/x' on showhaus.app, '/showhaus/l/x' → '/l/x' on other hosts; null when outside the app.
export function appPath(url) {
  if (onShowhaus(url)) return url.pathname;
  return url.pathname.startsWith('/showhaus/') ? url.pathname.slice('/showhaus'.length) : null;
}

let index = null;
async function slugs(request, env) {
  if (index) return index;
  try {
    const u = new URL(request.url);
    const r = await env.ASSETS.fetch(new Request(`${u.origin}/showhaus/data/listings.json`));
    if (!r.ok) return new Set();
    index = new Set(((await r.json()).listings || []).map(l => l.slug));
  } catch { return new Set(); }
  return index;
}
export function resetListingsForTests() { index = null; }

// Old links → the listing page. Pure (unit-tested): returns a Location or null.
export function legacyRedirect(url) {
  const path = appPath(url);
  if (path === null) return null;
  // Keep the visitor's other parameters (by=<claim code>, src, utm_*), drop the one the slug came from.
  const to = (slug, drop) => {
    const q = new URLSearchParams(url.search); q.delete(drop);
    const rest = q.toString();
    return `${url.origin}${base(url)}/l/${slug}${rest ? '?' + rest : ''}`;
  };
  if ((path === '/p/' || path === '/p/index.html') && SLUG.test(url.searchParams.get('a') || '')) return to(url.searchParams.get('a'), 'a');
  if ((path === '/studio/' || path === '/studio/index.html') && SLUG.test(url.searchParams.get('p') || '') && url.searchParams.get('embed') !== '1')
    return to(url.searchParams.get('p'), 'p');
  return null;
}

// Serve a page's HTML at a pretty URL. Its relative asset paths (./x.css, ../lib/…) are written for the page's own
// folder, so a <base href> pointing at that folder is added; nothing else in the HTML changes.
export function withBase(html, href) {
  return html.replace(/<head>/i, `<head>\n<base href="${href}">`);
}
async function page(env, request, url, file, search = '') {
  const target = new URL(`${url.origin}/showhaus/${file}${search}`);
  const res = await env.ASSETS.fetch(new Request(target, { method: 'GET', headers: request.headers }));
  if (!res.ok || !(res.headers.get('content-type') || 'text/html').includes('html')) return res;
  const folder = `${base(url)}/${file.slice(0, file.lastIndexOf('/') + 1)}`;
  const headers = new Headers(res.headers); headers.set('content-type', 'text/html; charset=utf-8'); headers.delete('content-length');
  return new Response(request.method === 'HEAD' ? null : withBase(await res.text(), folder), { status: 200, headers });
}

export async function handleListing(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  const legacy = legacyRedirect(url);
  if (legacy) return new Response(null, { status: 301, headers: { location: legacy, 'cache-control': 'public, max-age=3600' } });
  const path = appPath(url);
  if (path === null) return null;
  if (path === '/agent' || path === '/agent/' || path === '/agency' || path === '/agency/') return page(env, request, url, 'agent/index.html');
  const m = path.match(/^\/l\/([a-z0-9-]{3,80})(\/claim)?\/?$/);
  if (!m) return null;
  if (!(await slugs(request, env)).has(m[1])) {
    return new Response('This property is not on SHOWHAUS.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  // The claim page reads ?p=; carry the visitor's own query (utm_source, ref) along with it.
  if (m[2]) {
    const q = new URLSearchParams(url.search); q.set('p', m[1]);
    return page(env, request, url, 'claim/index.html', `?${q}`);
  }
  return page(env, request, url, 'l/index.html');
}
