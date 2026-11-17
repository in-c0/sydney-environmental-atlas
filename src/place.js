// SHOWHAUS address pages: one page for every NSW street address, rendered by this Worker when it is asked for.
//   GET /p/<slug>                 the page for one address in the NSW address register (GURAS). The slug is the register's
//                                 address in lower case with dashes ("4/17 FLOOD STREET CLOVELLY" → 4-17-flood-street-clovelly).
//                                 A slug that is a prebuilt listing kit (dist/showhaus/p/<slug>.json) goes to that kit page.
//                                 Not in the register → 404 page with the nearest register addresses, never a made-up one.
//   GET /p/go?q=<pasted>          an address or a listing link (src/hunt.js parsePasted) → 302 to that address's page.
//   GET /sitemap.xml              sitemap index of map tiles over Greater Sydney; GET /sitemaps/<x>_<y>.xml = every register
//                                 address inside that 0.01° tile, read from GURAS when asked (cached a week).
//   GET /robots.txt               points crawlers at the sitemap.
// Facts on the page are the same public checks as the hunt board (src/hunt.js: NSW Planning Portal zoning, bush fire, flood,
// airport noise; Sydney Airport ANEF 2039; NSW canopy) and the rent medians of the postcode (data/place-lookup.json, built
// from the map's NSW Fair Trading bond file by scripts/showhaus_place_data.py). Unknown stays unknown.
import { checkPoint, summarise, parsePasted, SVC, SYD_ANEF_PDF } from './hunt.js';
import { normalizeAddress, verifyAddress, lookupAddresses, prettyAddress, GURAS, inNSW } from './suggest.js';

const ORIGIN = 'https://showhaus.app';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- slugs ----------
export const slugOf = address => String(address || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// A slug back to what the register might hold. "4-17-flood-street-clovelly" is unit 4 of 17 or the range 4-17: try both.
export function candidatesOf(slug) {
  const s = String(slug || '').toLowerCase();
  if (!/^[0-9][a-z0-9-]{4,118}$/.test(s)) return [];
  const words = s.replace(/-/g, ' ');
  const m = s.match(/^(\d+[a-z]?)-(\d+[a-z]?)-(.+)$/);
  const out = m ? [`${m[1]}/${m[2]} ${m[3].replace(/-/g, ' ')}`, `${m[1]}-${m[2]} ${m[3].replace(/-/g, ' ')}`, words] : [words];
  return [...new Set(out.map(normalizeAddress).filter(Boolean))];
}

// ---------- lookups (built file, parsed once per isolate) ----------
let LOOKUP = null;
async function lookup(env) {
  if (LOOKUP) return LOOKUP;
  const r = await env.ASSETS.fetch(new Request(ORIGIN + '/showhaus/data/place-lookup.json'));
  if (!r.ok) throw new Error('place-lookup ' + r.status);
  LOOKUP = await r.json();
  return LOOKUP;
}
export function resetPlaceForTests() { LOOKUP = null; }
// The register has no postcode: the suburb from the address, nearest suburb centroid of that name (names repeat across NSW).
export function postcodeOf(L, label, [lng, lat]) {
  const sub = (String(label).split(',')[1] || '').replace(/\bNSW\b/i, '').trim().toLowerCase();
  let best = null, bd = Infinity;
  for (const s of L.suburbs) {
    if (String(s[0]).toLowerCase() !== sub) continue;
    const d = (s[2] - lat) ** 2 + (s[3] - lng) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { postcode: String(best[1]), suburb: best[0] } : { postcode: null, suburb: sub ? sub.replace(/\b\w/g, c => c.toUpperCase()) : null };
}
async function walks(env) {
  try { const r = await env.ASSETS.fetch(new Request(ORIGIN + '/showhaus/walk/data/index.json')); return r.ok ? (await r.json()).items || [] : []; } catch { return []; }
}
const near = (a, b) => a && b && Math.abs(a[0] - b[0]) < 0.0004 && Math.abs(a[1] - b[1]) < 0.0004;

async function kitExists(env, slug) {
  try { const r = await env.ASSETS.fetch(new Request(`${ORIGIN}/showhaus/p/${slug}.json`, { method: 'HEAD' })); return r.ok; } catch { return false; }
}

// ---------- routes ----------
export async function handlePlace(request, env, ctx) {
  const url = new URL(request.url);
  if (url.hostname !== 'showhaus.app' || request.method !== 'GET') return null;
  const path = url.pathname, fetchImpl = env.__fetch || fetch;
  if (path === '/robots.txt') return text(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${ORIGIN}/sitemap.xml\n`, 'text/plain');
  if (path === '/sitemap.xml') return text(sitemapIndex(), 'application/xml', 'public, max-age=86400');
  if (path === '/sitemaps/pages.xml') return text(pagesSitemap(), 'application/xml', 'public, max-age=86400');
  const tile = path.match(/^\/sitemaps\/(-?\d+)_(-?\d+)\.xml$/);
  if (tile) return cached(request, ctx, 604800, () => tileSitemap(+tile[1], +tile[2], fetchImpl));
  if (path === '/p/go' || path === '/p/go/') return go(url, fetchImpl);
  const m = path.match(/^\/p\/([a-z0-9-]{3,120})\/?$/);
  if (!m) return null;
  const slug = m[1];
  if (await kitExists(env, slug)) return Response.redirect(`${ORIGIN}/p/?a=${slug}${url.search ? '&' + url.search.slice(1) : ''}`, 302);
  return cached(request, ctx, 86400, () => placePage(slug, env, fetchImpl));
}

async function go(url, fetchImpl) {
  const q = String(url.searchParams.get('q') || '').slice(0, 300), parsed = parsePasted(q);
  const back = (msg, suburb) => html(askPage(q, msg, suburb), 200, 'no-store');
  if (!q.trim()) return back('');
  if (parsed.need) return back(parsed.suburb ? `That ${parsed.link || 'listing'} link only gives the suburb (${parsed.suburb}). Type the street address:` : 'That link does not show the street address. Type it here:', parsed.suburb);
  const norm = normalizeAddress(parsed.address);
  if (!norm) return back('Start with the house or unit number, e.g. 4/12 Smith St Blacktown.');
  let hit = null;
  try { hit = await verifyAddress(norm, fetchImpl); if (!hit) hit = (await lookupAddresses(norm, fetchImpl))[0] || null; } catch { return back('The NSW address register did not answer just now. Try again in a minute.'); }
  if (!hit) return back('That address is not in the NSW address register. Check the spelling, or try the street without the unit.');
  return Response.redirect(`${ORIGIN}/p/${slugOf(hit.address)}?src=paste${parsed.link ? '-' + parsed.link.replace(/\W+/g, '') : ''}`, 302);
}

async function placePage(slug, env, fetchImpl) {
  const cands = candidatesOf(slug);
  if (!cands.length) return html(notFound(slug, []), 404);
  let where = null;
  try {
    for (const c of cands) { where = await verifyAddress(c, fetchImpl); if (where) break; }
  } catch { return html(errorPage('The NSW address register did not answer just now. Try again in a minute.'), 503, 'no-store'); }
  if (!where) {
    const nearby = await lookupAddresses(cands[0].split(' ').slice(0, 3).join(' '), fetchImpl).catch(() => []);
    return html(notFound(slug, nearby), 404);
  }
  const canonical = slugOf(where.address);
  if (canonical !== slug) return Response.redirect(`${ORIGIN}/p/${canonical}`, 301);
  const [raw, L, W] = await Promise.all([checkPoint(fetchImpl, where.lngLat, env), lookup(env).catch(() => null), walks(env)]);
  const checks = summarise(raw);
  const pc = L ? postcodeOf(L, where.label, where.lngLat) : { postcode: null, suburb: null };
  const rent = L && pc.postcode ? L.rent[pc.postcode] || null : null;
  const walk = W.find(w => w.kind === 'walk' && near(w.lngLat, where.lngLat)) || null;
  return html(renderPlace({ slug, where, checks, raw, pc, rent, L, walk, checked: new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) }));
}

// ---------- page ----------
const weekly = v => v == null ? '—' : '$' + Math.round(v).toLocaleString('en-AU') + '/wk';
const ym = v => new Date(Date.UTC(Math.floor(v / 100), v % 100 - 1, 1)).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// One fact = what it says, how sure, and where it came from. The verdict word is plain: flagged / clear / unknown.
export function facts(checks, raw) {
  const z = checks.zoning, a = checks.aircraft, f = checks.flood, b = checks.bushfire, c = checks.canopy;
  return [
    { k: 'aircraft', label: 'Aircraft noise', state: !a ? 'unknown' : a.hit ? 'flag' : a.partial ? 'unknown' : 'clear', v: !a ? 'Could not be checked just now' : a.text, src: 'Sydney Airport ANEF 2039 (Airservices-endorsed; GIS by Randwick City Council) · NSW Planning Portal airport noise maps' },
    { k: 'flood', label: 'Flood', state: !f ? 'unknown' : f.hit ? 'flag' : 'clear', v: !f ? 'Could not be checked just now' : f.text, src: SVC.flood[0] },
    { k: 'bushfire', label: 'Bush fire', state: !b ? 'unknown' : b.hit ? 'flag' : 'clear', v: !b ? 'Could not be checked just now' : b.text, src: SVC.bushfire[0] },
    { k: 'zoning', label: 'Zoning', state: !z ? 'unknown' : 'info', v: !z ? 'Could not be checked just now' : [z.code, z.name].filter(Boolean).join(' · '), src: SVC.zoning[0] },
    { k: 'canopy', label: 'Trees', state: c ? 'info' : 'unknown', v: c ? `${c.pct}% tree canopy in the hexagon around it (about 2,600 m²)` : 'Not in the NSW canopy grid, or it did not answer', src: SVC.canopy[0] },
  ];
}
export function rentRows(rent) {
  if (!rent) return [];
  const row = (key, label) => { const x = rent[key]; return x ? { key, label, n: x[0], median: x[0] >= 10 ? x[1] : null, q1: x[0] >= 10 ? x[2] : null, q3: x[0] >= 10 ? x[3] : null } : { key, label, n: 0, median: null }; };
  return [row('all', 'All new leases'), row('units', 'Flats and units'), row('houses', 'Houses'), row('b1', '1 bedroom'), row('b2', '2 bedrooms'), row('b3', '3 bedrooms'), row('b4', '4+ bedrooms')];
}

function renderPlace({ slug, where, checks, raw, pc, rent, L, walk, checked }) {
  const label = where.label, [street, suburbPart] = label.split(', ');
  const place = [pc.suburb || (suburbPart || '').replace(/ NSW$/, ''), 'NSW', pc.postcode].filter(Boolean).join(' ');
  const F = facts(checks, raw), R = rentRows(rent), flagged = F.filter(f => f.state === 'flag');
  const air = checks.aircraft;
  const title = `${street}, ${place} — flood, bush fire, aircraft noise, zoning, rent`;
  const desc = `${street}, ${place}: ${F.filter(f => f.k !== 'canopy').map(f => `${f.label.toLowerCase()} ${f.state === 'unknown' ? 'unknown' : f.v.replace(/\s*\(.*?\)\s*/g, ' ').trim()}`).join('; ')}${R[0] && R[0].median ? `; median new lease in ${pc.postcode} ${weekly(R[0].median)}` : ''}. From NSW government data, each with its source.`.slice(0, 300);
  const q = encodeURIComponent(label);
  const ld = { '@context': 'https://schema.org', '@type': 'Place', name: label, address: { '@type': 'PostalAddress', streetAddress: street, addressLocality: pc.suburb || undefined, addressRegion: 'NSW', postalCode: pc.postcode || undefined, addressCountry: 'AU' }, geo: { '@type': 'GeoCoordinates', longitude: where.lngLat[0], latitude: where.lngLat[1] } };
  const factLi = f => `<li class="f ${f.state}" data-k="${f.k}" data-state="${f.state}"><b>${esc(f.label)}</b><span>${esc(f.v)}${f.state === 'unknown' ? ' <em class="tag">unknown</em>' : ''}</span><small>${esc(f.src)}</small></li>`;
  const rentTr = r => `<tr data-k="${r.key}" data-n="${r.n}"><th>${r.label}</th><td>${r.median != null ? `<b>${weekly(r.median)}</b>` : r.n ? '<span class="few">fewer than 10 leases</span>' : '<span class="few">none lodged</span>'}</td><td>${r.median != null ? `${weekly(r.q1)}–${weekly(r.q3).replace('/wk', '')}` : ''}</td><td>${r.n.toLocaleString('en-AU')}</td></tr>`;
  const months = L ? `${ym(L.months[0])}–${ym(L.months[1])}` : '';
  return page({ title: `${title} · SHOWHAUS`, desc, canonical: `${ORIGIN}/p/${slug}`, ld, body: `
<header class="top"><a class="brand" href="/">SHOWHAUS</a><form class="go" action="/p/go" method="get" role="search"><input name="q" placeholder="Paste another address or listing link" aria-label="Another address or listing link" autocomplete="street-address"><button>Check</button></form></header>
<main class="place">
  <h1>${esc(street)}<span>${esc(place)}</span></h1>
  <p class="lede">${flagged.length ? `<b>${flagged.length} thing${flagged.length > 1 ? 's' : ''} to look into:</b> ${flagged.map(f => esc(f.label.toLowerCase())).join(', ')}.` : '<b>No flood, bush fire or aircraft-noise flag</b> in the NSW maps checked here.'} For renters and buyers alike — from NSW government data, checked ${esc(checked)}.</p>
  <nav class="acts">
    <a class="btn main" href="/hunt/?q=${q}&src=place" data-cta="hunt">＋ Add to my shortlist</a>
    ${walk ? `<a class="btn" href="/walk/?p=${esc(walk.slug)}&src=place" data-cta="walk">▶ Walk it in 3D</a>` : `<a class="btn" href="/walk/?a=${q}&src=place" data-cta="walk-ask">Ask for a 3D walk of this home</a>`}
    <a class="btn" href="/?src=place" data-cta="map">Sydney rents map</a>
  </nav>
  <ul class="facts">${F.map(factLi).join('')}</ul>
  ${air && air.hit && air.source === 'sydney_anef' ? `<p class="note">ANEF is the forecast yearly average of aircraft noise; it is what NSW planning uses. The endorsed map: <a href="${SYD_ANEF_PDF}" rel="noopener">Sydney Airport ANEF 2039 (Airservices)</a>.</p>` : ''}
  <section class="rent" aria-labelledby="rentH">
    <h2 id="rentH">Rent in ${pc.postcode ? 'postcode ' + esc(pc.postcode) : 'this area'}</h2>
    ${R.length ? `<table><thead><tr><th></th><th>Median</th><th>Middle half</th><th>Leases</th></tr></thead><tbody>${R.map(rentTr).join('')}</tbody></table>
    <p class="src">New bonds lodged ${esc(months)}, whole postcode · NSW Fair Trading rental bond data (CC BY 4.0), medians by SHOWHAUS. A guide to what this area rents for, not a valuation of this home.</p>` : `<p class="unk">No rental bond records for ${pc.postcode ? 'postcode ' + esc(pc.postcode) : 'this address (postcode not found)'} <em class="tag">unknown</em></p>`}
  </section>
  <section class="cant">
    <h2>Not on this page</h2>
    <p>Sold prices, road and rail noise, what the inside is like, strata, and council flood maps that are not in the state layer yet. Before you sign, a planning certificate (section 10.7) from the council is the legal answer.</p>
  </section>
  <p class="src">Address point: NSW Spatial Services address register (GURAS), ${where.lngLat[1].toFixed(5)}, ${where.lngLat[0].toFixed(5)}. Page made from public data when it was asked for; nothing here is from the listing or the owner.</p>
</main>` });
}

function askPage(q, msg, suburb) {
  return page({ title: 'Check an address · SHOWHAUS', desc: 'Paste a NSW street address or a listing link to see its flood, bush fire, aircraft noise, zoning and rent from NSW government data.', canonical: `${ORIGIN}/p/go`, robots: 'noindex', body: `
<header class="top"><a class="brand" href="/">SHOWHAUS</a></header>
<main class="place ask">
  <h1>Check an address<span>NSW · renters and buyers</span></h1>
  ${msg ? `<p class="lede">${esc(msg)}</p>` : '<p class="lede">Paste a street address or a listing link.</p>'}
  <form class="go big" action="/p/go" method="get"><input name="q" value="${esc(suburb ? '' : q)}" placeholder="${suburb ? 'e.g. 12 Smith St ' + esc(suburb) : 'e.g. 4/12 Smith St Blacktown'}" aria-label="Street address" autofocus autocomplete="street-address"><button>Check</button></form>
</main>` });
}
function notFound(slug, nearby) {
  return page({ title: 'Address not found · SHOWHAUS', desc: 'This address is not in the NSW address register.', canonical: `${ORIGIN}/p/${slug}`, robots: 'noindex', body: `
<header class="top"><a class="brand" href="/">SHOWHAUS</a></header>
<main class="place ask">
  <h1>Not in the NSW address register<span>${esc(slug.replace(/-/g, ' '))}</span></h1>
  <p class="lede">SHOWHAUS only makes a page for an address the NSW register knows, so nothing here is guessed.${nearby.length ? ' Did you mean one of these?' : ''}</p>
  ${nearby.length ? `<ul class="near">${nearby.map(n => `<li><a href="/p/${slugOf(n.address)}">${esc(n.label)}</a></li>`).join('')}</ul>` : ''}
  <form class="go big" action="/p/go" method="get"><input name="q" placeholder="e.g. 4/12 Smith St Blacktown" aria-label="Street address" autocomplete="street-address"><button>Check</button></form>
</main>` });
}
function errorPage(msg) {
  return page({ title: 'Try again · SHOWHAUS', desc: msg, robots: 'noindex', body: `<header class="top"><a class="brand" href="/">SHOWHAUS</a></header><main class="place ask"><h1>Try again in a minute</h1><p class="lede">${esc(msg)}</p></main>` });
}
function page({ title, desc, canonical, ld, robots, body }) {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${robots ? `<meta name="robots" content="${robots}">` : ''}${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(title.replace(/ · SHOWHAUS$/, ''))}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:site_name" content="SHOWHAUS">
<meta name="theme-color" content="#f6f3ec">
<link rel="stylesheet" href="/p/place.css">
${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>${body}
<script src="/lib/ops.js" defer></script>
<script>document.addEventListener('click',e=>{const a=e.target.closest('[data-cta]');if(!a)return;try{navigator.sendBeacon('/api/e',new Blob([JSON.stringify({name:'cta',path:location.pathname,props:{cta:a.dataset.cta,kind:'place'}})],{type:'application/json'}))}catch(_){}});</script>
</body>
</html>`;
}

// ---------- sitemaps ----------
// Greater Sydney, 0.01° tiles (about 1 km × 1.1 km). Tile x_y = floor(lng*100)_floor(-lat*100).
export const SYD_BOX = { w: 150.52, e: 151.35, s: -34.18, n: -33.55 };
export function tiles() {
  const out = [];
  for (let x = Math.floor(SYD_BOX.w * 100); x < Math.ceil(SYD_BOX.e * 100); x++)
    for (let y = Math.floor(-SYD_BOX.n * 100); y < Math.ceil(-SYD_BOX.s * 100); y++) out.push([x, y]);
  return out;
}
function sitemapIndex() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<sitemap><loc>${ORIGIN}/sitemaps/pages.xml</loc></sitemap>\n${tiles().map(([x, y]) => `<sitemap><loc>${ORIGIN}/sitemaps/${x}_${y}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;
}
// The app's own pages and the prebuilt listing kits (dist/showhaus/p/<slug>.json).
export const KITS = ['108-201-carrington-rd-coogee', '14-ethel-st-randwick', '2-174-178-brook-st-coogee', '2-37-39-arden-st-clovelly', '3-377c-clovelly-rd-clovelly', '4-17-flood-st-clovelly', '40-melrose-pde-clovelly', '499-bronte-rd-bronte', '7-walsh-ave-maroubra', '8-knox-st-clovelly'];
function pagesSitemap() {
  const urls = ['/', '/hunt/', '/walk/']; // listing kits (KITS) stay noindex: they were made for one agent each
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${ORIGIN}${u.replace(/&/g, '&amp;')}</loc></url>`).join('\n')}\n</urlset>\n`;
}
export const TILE_PAGES = 3, TILE_PAGE_SIZE = 2000;
async function tileSitemap(x, y, fetchImpl) {
  if (!tiles().some(([a, b]) => a === x && b === y)) return text('not a tile', 'text/plain', 'no-store', 404);
  const env = { xmin: x / 100, xmax: (x + 1) / 100, ymin: -(y + 1) / 100, ymax: -y / 100 };
  const seen = new Set();
  for (let p = 0; p < TILE_PAGES; p++) {
    const q = new URLSearchParams({ where: '1=1', geometry: `${env.xmin},${env.ymin},${env.xmax},${env.ymax}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'address', returnGeometry: 'false', orderByFields: 'address', resultOffset: String(p * TILE_PAGE_SIZE), resultRecordCount: String(TILE_PAGE_SIZE), f: 'json' });
    let d;
    try {
      const r = await fetchImpl(GURAS + '?' + q, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000), cf: { cacheTtl: 604800, cacheEverything: true } });
      if (!r.ok) throw new Error('guras ' + r.status);
      d = await r.json();
      if (d.error) throw new Error('guras error');
    } catch { if (!p) return text('register did not answer', 'text/plain', 'no-store', 503); break; }
    for (const f of d.features || []) { const a = f.attributes && f.attributes.address; if (a && /^\d/.test(a)) seen.add(slugOf(a)); }
    if (!d.exceededTransferLimit && (d.features || []).length < TILE_PAGE_SIZE) break;
  }
  return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...seen].sort().map(s => `<url><loc>${ORIGIN}/p/${s}</loc></url>`).join('\n')}\n</urlset>\n`, 'application/xml', 'public, max-age=604800');
}

// ---------- responses ----------
const text = (body, type, cache = 'public, max-age=86400', status = 200) => new Response(body, { status, headers: { 'content-type': type + '; charset=utf-8', 'cache-control': cache } });
const html = (body, status = 200, cache = 'public, max-age=3600') => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': status === 200 ? cache : 'public, max-age=600' } });
// Edge cache for rendered pages: a crawler or a second visitor never re-asks the NSW services within the day.
async function cached(request, ctx, ttl, make) {
  const cache = typeof caches !== 'undefined' ? caches.default : null, key = new Request(new URL(request.url).origin + new URL(request.url).pathname, { method: 'GET' });
  if (cache) { const hit = await cache.match(key).catch(() => null); if (hit) return hit; }
  const res = await make();
  if (cache && res.status === 200) {
    const copy = new Response(res.clone().body, res); copy.headers.set('cache-control', `public, max-age=${ttl}`);
    ctx && ctx.waitUntil && ctx.waitUntil(cache.put(key, copy).catch(() => {}));
  }
  return res;
}
export { inNSW };
