// Host routing for one static deployment:
//   map.lifeos.studio (and every other host) → the atlas, exactly as before
//   showhaus.app / www.showhaus.app          → the SHOWHAUS app at the root (served from dist/showhaus/)
const SHOWHAUS_HOSTS = new Set(['showhaus.app', 'www.showhaus.app']);

export function rewrite(url) {
  const u = new URL(url);
  if (!SHOWHAUS_HOSTS.has(u.hostname)) return null;
  if (u.hostname === 'www.showhaus.app') return { redirect: `https://showhaus.app${u.pathname}${u.search}` };
  if (u.pathname.startsWith('/showhaus/')) return { redirect: `https://showhaus.app${u.pathname.slice('/showhaus'.length)}${u.search}` };
  u.pathname = '/showhaus' + (u.pathname === '/' ? '/' : u.pathname);
  return { asset: u.toString() };
}

export default {
  async fetch(request, env) {
    const r = rewrite(request.url);
    if (!r) return env.ASSETS.fetch(request);
    if (r.redirect) return Response.redirect(r.redirect, 301);
    return env.ASSETS.fetch(new Request(r.asset, request));
  },
};
