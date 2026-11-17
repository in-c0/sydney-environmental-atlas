// Host routing for one static deployment:
//   map.lifeos.studio (and every other host) → the atlas, exactly as before
//   showhaus.app / www.showhaus.app          → the SHOWHAUS app at the root (served from dist/showhaus/)
import { handleOps, observeCheckout } from './ops/index.js';
import { handleStudio } from './studio.js';
import { handleClaim, isPrivate } from './claim.js';
import { handleSuggest } from './suggest.js';
import { handleHunt } from './hunt.js';
import { handleArrange } from './arrange.js';
import { handlePlace } from './place.js';
export { AuRelay } from './au-relay.js';

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
  async fetch(request, env, ctx) {
    const ops = await handleOps(request, env, ctx);
    if (ops) return ops;
    const res = (await handleClaim(request, env, ctx)) || (await handleSuggest(request, env, ctx)) || (await handleHunt(request, env, ctx)) || (await handlePlace(request, env, ctx)) || (await handleArrange(request, env, ctx)) || (await handleStudio(request, env, ctx)) || (await route(request, env));
    return observeCheckout(request, res, env, ctx) || res;
  },
};

// A walk listing made private by its builder: its scene, clips and listing file are no longer served to anyone.
const WALK_DATA = /^(?:\/showhaus)?\/walk\/data\/([a-z0-9-]{3,80})(?:\.json|\/.*)$/;
export const PRIVATE_NOTE = 'This home has been made private at the builder\'s request.';

// Everything that is not an ops route: static assets with SHOWHAUS host routing.
async function route(request, env) {
  const walk = new URL(request.url).pathname.match(WALK_DATA);
  if (walk && await isPrivate(env, walk[1])) return new Response(PRIVATE_NOTE, { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  const r = rewrite(request.url);
  if (!r) return env.ASSETS.fetch(request);
  if (r.redirect) return Response.redirect(r.redirect, 301);
  return env.ASSETS.fetch(new Request(r.asset, request));
}
