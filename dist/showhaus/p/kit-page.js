/* SHOWHAUS property experience page. Every number is read from <slug>.json or computed here from it; unknown stays unknown. */
(() => {
  'use strict';
  const C = window.ShowhausCore, K = window.ShowhausKit;
  const $ = id => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const slug = (qs.get('a') || '').toLowerCase();
  const src = (qs.get('src') || '').slice(0, 80);
  const REC = qs.get('rec') === '1', SCENE = qs.get('scene');
  const quiet = REC || !!SCENE; // the recorder never counts as a visitor
  const MAPLIBRE = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
  const STYLE = 'https://tiles.openfreemap.org/styles/positron';
  const sydneyDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
  const fmtDay = ymd => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const fmtYm = ym => new Date(Date.UTC(Math.floor(ym / 100), ym % 100 - 1, 1)).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tag = t => `<span class="tag ${t}">${t === 'est' ? 'est.' : t}</span>`;
  const compass = a => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8];
  const titleCase = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  if (REC) document.body.classList.add('rec');
  window.__kit = { ready: false, idle: () => true };

  // ---------- events: the SHOWHAUS /api/e contract (src/ops/events.js), with no id, cookie or storage ----------
  // view → {name:'view', props:{kit, utm_source}}; clicks → {name:'cta', props:{cta:'explore'|'listing', kit, utm_source}}.
  function track(name, props = {}) {
    if (quiet || !slug) return;
    try {
      const body = JSON.stringify({ name, path: location.pathname, props: { kit: slug, utm_source: src || undefined, ...props } });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/e', new Blob([body], { type: 'application/json' })))) fetch('/api/e', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
    } catch { /* tracking never breaks the page */ }
  }

  let kit = null, map = null, mapReady = false;
  const sweep = { day: 'today', t: 0, playing: !SCENE, last: 0 };
  const days = () => ({ today: sydneyDay(), winter: sydneyDay().slice(0, 4) + '-06-21' });

  async function boot() {
    if (!/^[a-z0-9-]{3,80}$/.test(slug)) return fail('No property chosen. This page opens from a SHOWHAUS link for one address.');
    let r;
    try { r = await fetch(`./${slug}.json`); } catch (e) { return fail('Could not load this property: ' + e.message); }
    if (!r.ok) return fail(r.status === 404 ? 'This property link is not (or no longer) on SHOWHAUS.' : 'Could not load this property (HTTP ' + r.status + ').');
    kit = await r.json();
    document.title = `${kit.address} · SHOWHAUS`;
    renderHead(); renderFacts(); renderRent(); renderSources();
    document.body.dataset.state = 'facts';
    track('view');
    // Sun hours for the visitor's today and 21 June, from the stored buildings (deterministic; the judge recounts the same way).
    setTimeout(() => { computeSun(); renderFacts(); document.body.dataset.state = 'ready-facts'; loadMap(); }, 0);
  }
  function fail(msg) {
    $('addr').textContent = 'Property not found';
    $('sub').textContent = msg;
    $('facts').innerHTML = ''; $('rent').innerHTML = '';
    document.body.dataset.state = 'error';
    window.__kit.ready = true;
  }

  // ---------- panel ----------
  function renderHead() {
    const lot = kit.lot.lots.map(l => l.label).filter(Boolean).join(', ');
    $('addr').textContent = kit.address;
    $('sub').textContent = `${lot || 'lot not found in the cadastre'} · ${kit.geocode.lat.toFixed(5)}, ${kit.geocode.lng.toFixed(5)} · kit built ${fmtDate(kit.generated_at)}`;
    $('explore').href = '../' + (src ? '?src=' + encodeURIComponent(src) : '');
  }
  let sun = null;
  function computeSun() {
    const d = days();
    sun = { today: K.groundSun(kit, d.today), winter: K.groundSun(kit, d.winter) };
  }
  function sunFact(key, label, s) {
    if (!s) return `<li class="fact sun" data-k="${key}"><div class="k">${label}</div><div class="v">…</div><div class="s">casting shadows from mapped buildings</div></li>`;
    if (!s.known) return `<li class="fact sun unknown" data-k="${key}" data-v="unknown" data-day="${s.day}"><div class="k">${label}</div><div class="v">unknown ${tag('unknown')}</div><div class="s" title="${esc(s.why)}">${esc(s.why)} · daylight ${K.hm(s.daylight)}</div></li>`;
    return `<li class="fact sun" data-k="${key}" data-v="${s.minutes}" data-day="${s.day}"><div class="k">${label}</div><div class="v">${K.hm(s.minutes)} ${tag('est')}</div><div class="s">direct sun at ground level, lot open ground (median of ${s.n} points) · daylight ${K.hm(s.daylight)}</div></li>`;
  }
  function planRow(key, label, r, fmt, none, extra = '') {
    const when = fmtDate(r.fetched);
    if (!r.ok) return `<li class="fact unknown" data-k="${key}" data-v="unknown"><div class="k">${label}</div><div class="v">unknown ${tag('unknown')}</div><div class="s">service did not answer (${esc(r.error || '')}) · ${when}</div></li>`;
    const v = r.rows.length ? fmt(r.rows[0]) : none;
    return `<li class="fact" data-k="${key}" data-v="${esc(v)}"><div class="k">${label}</div><div class="v">${esc(v)}</div><div class="s">${extra}NSW Planning Portal · ${when}</div></li>`;
  }
  function renderFacts() {
    const d = days();
    const road = kit.roads.nearest, when = fmtDate(kit.roads.fetched);
    const main = road.main, any = road.any;
    const roadFact = main
      ? `<li class="fact" data-k="road-main" data-v="${main.distance_m}"><div class="k">Nearest main road</div><div class="v">${main.distance_m.toLocaleString('en-AU')} m <small>${esc(main.name || main.cls)}</small></div><div class="s">straight line to OSM ${esc(main.cls)} road · nearest any road ${any ? any.distance_m + ' m' + (any.name ? ' (' + esc(any.name) + ')' : '') : '—'} · OpenStreetMap ${when}</div></li>`
      : `<li class="fact" data-k="road-main" data-v=">2500"><div class="k">Nearest main road</div><div class="v">over 2.5 km</div><div class="s">no OSM motorway, trunk or primary road within 2.5 km · OpenStreetMap ${when}</div></li>`;
    const cn = kit.canopy, crow = cn.rows[0];
    const canopyFact = !cn.ok ? `<li class="fact unknown" data-k="canopy" data-v="unknown"><div class="k">Tree canopy</div><div class="v">unknown ${tag('unknown')}</div><div class="s">NSW canopy service did not answer · ${fmtDate(cn.fetched)}</div></li>`
      : !crow ? `<li class="fact unknown" data-k="canopy" data-v="unknown"><div class="k">Tree canopy</div><div class="v">unknown ${tag('unknown')}</div><div class="s">outside the NSW 2024–25 canopy grid · ${fmtDate(cn.fetched)}</div></li>`
      : `<li class="fact" data-k="canopy" data-v="${Math.round(crow.Canopy_pc * 100)}"><div class="k">Tree canopy</div><div class="v">${Math.round(crow.Canopy_pc * 100)}% <small>of this hexagon</small></div><div class="s">NSW 2024–25 canopy H3 cell around the address · fetched ${fmtDate(cn.fetched)}</div></li>`;
    const wsa = kit.aircraft.wsa_anec;
    const airFact = `<li class="fact unknown" data-k="aircraft" data-v="unknown"><div class="k">Aircraft noise (ANEF)</div><div class="v">unknown ${tag('unknown')}</div><div class="s">Sydney Airport ANEF 2039 has no public GIS layer · Western Sydney ANEC: ${wsa.ok ? (wsa.rows.length ? 'ANEC ' + esc(wsa.rows.map(x => x.ANEF_CODE).join(', ')) : 'outside') : 'unknown'} · ${fmtDate(wsa.fetched)}</div></li>`;
    const pl = kit.planning;
    $('facts').innerHTML = [
      sunFact('sun-today', `Sun · today ${fmtDay(d.today)}`, sun?.today),
      sunFact('sun-winter', 'Sun · 21 June', sun?.winter),
      roadFact, canopyFact, airFact,
      planRow('flood', 'Flood planning', pl.flood, a => a.LAY_CLASS || 'inside a flood planning area', 'not in the state flood layer', 'many council flood maps are not in it · '),
      planRow('bushfire', 'Bush fire prone land', pl.bushfire, a => a.d_Category || `Category ${a.Category}`, 'not mapped as prone', 'RFS certified map · '),
      planRow('zoning', 'Zoning', pl.zoning, a => `${a.SYM_CODE} ${titleCase(a.LAY_CLASS)}`, 'no LEP zone mapped', `${esc(pl.zoning.rows[0]?.EPI_NAME || '')} · `),
    ].join('');
  }
  function renderRent() {
    const r = kit.rent;
    if (!r) { $('rent').innerHTML = `<div class="k">Rent context</div><div class="v">unknown ${tag('unknown')}</div><div class="s">no rental bond records for this postcode</div>`; return; }
    const w = C.weekly, pc = String(r.postcode).padStart(4, '0');
    const part = (label, x, key) => x.n >= 10 ? `<span data-k="${key}" data-v="${x.median}" data-n="${x.n}">${label} ${w(x.median)} (${x.n.toLocaleString('en-AU')})</span>` : `<span data-k="${key}" data-v="few" data-n="${x.n}">${label}: fewer than 10 leases</span>`;
    $('rent').innerHTML = `<div class="k">Rent context · postcode ${pc}${r.suburbs?.length ? ' (' + esc(r.suburbs.slice(0, 3).join(', ')) + (r.suburbs.length > 3 ? '…' : '') + ')' : ''}</div>
      <div class="v"><b data-k="rent-all" data-v="${r.all.median}" data-n="${r.all.n}">${w(r.all.median)}</b> <span>median new lease · ${r.all.n.toLocaleString('en-AU')} leases ${tag('counted')}</span></div>
      <div class="s">${part('units', r.units, 'rent-units')} · ${part('houses', r.houses, 'rent-houses')} · NSW Fair Trading rental bonds ${fmtYm(r.months[0])}–${fmtYm(r.months[1])}, whole postcode, SHOWHAUS median</div>`;
  }
  function renderSources() {
    const k = kit, b = k.buildings.counts;
    const li = (name, url, when, note = '') => `<li><b>${esc(name)}</b>${note ? ' — ' + note : ''}<br><a href="${esc(url)}" rel="noopener" target="_blank">${esc(url.length > 110 ? url.slice(0, 110) + '…' : url)}</a> · ${fmtDate(when)}</li>`;
    const s = sun || {};
    const ifEst = x => x && !x.known && x.ifEstimated != null ? ` If those buildings were about their estimated height, the modelled figure would be ${K.hm(x.ifEstimated)} — a model, not a measurement, so the panel shows "unknown".` : '';
    $('srcBody').innerHTML = `<p><b>${esc(k.address)}</b> — located by ${esc(k.geocode.method)}.</p>
      <ul>
        ${li('NSW address point (Geocoded Addressing Theme)', k.geocode.gat?.url || k.geocode.nominatim?.url, k.geocode.fetched, esc(k.geocode.gat?.address || 'no match'))}
        ${k.geocode.nominatim?.url ? li('Nominatim (OpenStreetMap)', k.geocode.nominatim.url, k.geocode.fetched, esc(k.geocode.nominatim.display_name || k.geocode.nominatim.error || '')) : ''}
        ${li(k.lot.source, k.lot.url, k.lot.fetched, esc(k.lot.lots.map(l => l.label).join(', ') || 'no parcel at the point'))}
        ${li(k.buildings.source, k.buildings.url, k.buildings.fetched, `${b.total} footprints within ${k.buildings.radius_m} m: ${b.height} with a mapped height, ${b.levels} with mapped storeys (× 3 m), ${b.estimated} estimated (${esc(k.buildings.estimate_rule)}). ${esc(k.buildings.licence)}`)}
        ${li(k.roads.source, k.roads.tiles, k.roads.fetched, esc(k.roads.main_rule))}
        ${li(k.canopy.name, k.canopy.url, k.canopy.fetched)}
        ${li(k.planning.zoning.name, k.planning.zoning.url, k.planning.zoning.fetched)}
        ${li(k.planning.flood.name, k.planning.flood.url, k.planning.flood.fetched, 'only some councils’ flood maps are in this state layer, so “not in the layer” is not “won’t flood”')}
        ${li(k.planning.bushfire.name, k.planning.bushfire.url, k.planning.bushfire.fetched)}
        ${li(k.aircraft.wsa_anec.name, k.aircraft.wsa_anec.url, k.aircraft.wsa_anec.fetched, esc(k.aircraft.sydney_anef.why))}
        ${k.rent ? `<li><b>Rents</b> — ${esc(k.rent.source)}; medians computed by SHOWHAUS from every lodgement in the postcode (data built ${fmtDate(k.rent.built)}).</li>` : ''}
      </ul>
      <p><b>Sun method.</b> NOAA solar position every 10 minutes, shadows cast on level ground by OpenStreetMap building footprints (no trees, no terrain, no fences). Ground sun is the median over ${k.ground.points.length} open-ground points on the lot. It is reported only when every building within ${K.NEAR_M} m of the lot has a mapped height (or mapped storeys); otherwise it reads "unknown".${ifEst(s.today)}${ifEst(s.winter)} Sun below 6° or shadows longer than 220 m count as uncertain, never as sun.</p>
      <p><b>3D view.</b> Building heights from OpenStreetMap; unmapped heights are estimated (pale buildings). The moving shadows include the estimated buildings and are a picture of the model, not a survey. Check a planning certificate (s10.7) before you sign.</p>`;
  }

  // ---------- map ----------
  function loadMap() {
    if (window.maplibregl) return initMap();
    const s = document.createElement('script');
    s.src = MAPLIBRE; s.onload = initMap; s.onerror = () => { $('legend').textContent = 'The 3D map could not load (MapLibre). The facts on the right do not depend on it.'; window.__kit.ready = true; };
    document.head.appendChild(s);
  }
  function legend() {
    const b = kit.buildings.counts;
    const mapped = b.height + b.levels;
    $('legend').innerHTML = `<i style="background:#c4622d"></i>mapped height (${mapped})<i style="background:#d8cdb8;border:1px solid #b9ab92"></i>estimated (${b.estimated})<i style="background:#7d5fc7"></i>lot · building heights from OpenStreetMap${b.estimated ? '; unmapped heights are estimated' : ''}`;
  }
  function geo() {
    const blds = { type: 'FeatureCollection', features: kit.buildings.features.map(b => ({ type: 'Feature', properties: { h: b.h, min: b.min || 0, src: b.src }, geometry: { type: 'Polygon', coordinates: [b.ring] } })) };
    const lot = { type: 'FeatureCollection', features: kit.lot.lots.map(l => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: l.rings } })) };
    const p = [kit.geocode.lng, kit.geocode.lat], f = [];
    f.push({ type: 'Feature', properties: { k: 'pin' }, geometry: { type: 'Point', coordinates: p } });
    if (kit.roads.nearest.main) f.push({ type: 'Feature', properties: { k: 'road', label: `${kit.roads.nearest.main.distance_m.toLocaleString('en-AU')} m to ${kit.roads.nearest.main.name || 'main road'}` }, geometry: { type: 'LineString', coordinates: [p, kit.roads.nearest.main.at] } });
    const mains = kit.roads.lines.filter(l => K.MAIN.has(l.cls)).map(l => ({ type: 'Feature', properties: { k: 'main' }, geometry: { type: 'LineString', coordinates: l.pts } }));
    return { blds, lot, pick: { type: 'FeatureCollection', features: [...f, ...mains] } };
  }
  function initMap() {
    const p = [kit.geocode.lng, kit.geocode.lat];
    map = new maplibregl.Map({ container: 'map', style: STYLE, center: p, zoom: REC ? 17.4 : 17.35, pitch: 58, bearing: -25, attributionControl: { compact: true }, maxPitch: 75, preserveDrawingBuffer: REC || !!SCENE, fadeDuration: 0 });
    map.on('error', e => { if (!mapReady) $('legend').textContent = 'Map tiles could not load: ' + (e.error?.message || 'unknown'); });
    map.on('load', () => {
      for (const l of map.getStyle().layers) if (l['source-layer'] === 'building' || /poi|housenumber/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
      const g = geo();
      map.addSource('shadow', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('lot', { type: 'geojson', data: g.lot });
      map.addSource('blds', { type: 'geojson', data: g.blds });
      map.addSource('pick', { type: 'geojson', data: g.pick });
      map.addLayer({ id: 'lot-fill', type: 'fill', source: 'lot', paint: { 'fill-color': '#7d5fc7', 'fill-opacity': .22 } });
      map.addLayer({ id: 'shadow', type: 'fill', source: 'shadow', paint: { 'fill-color': '#1d2733', 'fill-opacity': .3, 'fill-antialias': false } });
      map.addLayer({ id: 'lot-line', type: 'line', source: 'lot', paint: { 'line-color': '#7d5fc7', 'line-width': 3 } });
      map.addLayer({ id: 'main-road', type: 'line', source: 'pick', filter: ['==', ['get', 'k'], 'main'], paint: { 'line-color': '#c4622d', 'line-width': 4, 'line-opacity': .75 } });
      map.addLayer({ id: 'road-link', type: 'line', source: 'pick', filter: ['==', ['get', 'k'], 'road'], paint: { 'line-color': '#2f4c7a', 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'blds', type: 'fill-extrusion', source: 'blds', paint: {
        'fill-extrusion-color': ['match', ['get', 'src'], 'height', '#c4622d', 'levels', '#d98a45', '#d8cdb8'],
        'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'min'], 'fill-extrusion-opacity': .92 } });
      map.addLayer({ id: 'pin', type: 'circle', source: 'pick', filter: ['==', ['get', 'k'], 'pin'], paint: { 'circle-radius': 6, 'circle-color': '#7d5fc7', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } });
      mapReady = true;
      legend();
      if (SCENE) { sweep.playing = false; $('play').textContent = '▶'; const [day, hh] = SCENE.split('-'); sweep.day = day === 'winter' ? 'winter' : 'today'; setDayButtons(); setMinutes(Number(hh || 15) * 60); }
      else setT(REC ? 0 : startT());
      // Ready once the first frame with tiles has settled; only then start the sweep (a playing sweep keeps the map busy).
      map.once('idle', () => { window.__kit.ready = true; document.body.dataset.state = 'ready'; if (!REC && !SCENE) requestAnimationFrame(tick); });
    });
  }

  // ---------- sun sweep ----------
  function window_() { const day = days()[sweep.day]; const { rise, set } = K.sunriseSunset(kit.geocode.lat, kit.geocode.lng, day); return { day, rise, set }; }
  function startT() { const w = window_(), now = nowMinutes(); return Math.min(1, Math.max(0, (now - w.rise) / (w.set - w.rise))) || 0; }
  function nowMinutes() { const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()); return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value); }
  function setMinutes(m) { const w = window_(); setT((m - w.rise) / (w.set - w.rise)); }
  function setT(t) {
    sweep.t = Math.min(1, Math.max(0, t));
    const w = window_(), m = w.rise + (w.set - w.rise) * sweep.t;
    $('time').value = Math.round(sweep.t * 1000);
    const { sun, fc } = K.shadowsAt(kit, w.day, m);
    if (mapReady) map.getSource('shadow').setData(fc);
    const sunTxt = sun.elevation > 0 ? `sun ${Math.round(sun.elevation)}° ${compass(sun.azimuth)}` : 'sun down';
    const low = sun.elevation > 0 && sun.elevation <= 6 ? ' · low sun, shadows not modelled' : '';
    $('clock').textContent = `${K.clock(m)} · ${sunTxt}${low}`;
    $('caption').innerHTML = `<b>${esc(kit.address.replace(/ NSW \d{4}$/, ''))}</b><span>${sweep.day === 'winter' ? '21 Jun' : fmtDay(w.day)} · <em>${K.clock(m)}</em> · ${sunTxt}${low ? ' (low)' : ''}</span><small>SHOWHAUS · building heights from OpenStreetMap; unmapped heights are estimated</small>`;
  }
  function tick(ts) {
    if (sweep.playing && ts - sweep.last > 50) { sweep.last = ts; setT(sweep.t >= 1 ? 0 : sweep.t + 0.004); }
    requestAnimationFrame(tick);
  }
  function setDayButtons() { document.querySelectorAll('.days button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.day === sweep.day))); }
  $('play').addEventListener('click', () => { sweep.playing = !sweep.playing; $('play').textContent = sweep.playing ? '❚❚' : '▶'; $('play').setAttribute('aria-label', sweep.playing ? 'Pause the sun sweep' : 'Play the sun sweep'); });
  $('time').addEventListener('input', e => { sweep.playing = false; $('play').textContent = '▶'; setT(e.target.value / 1000); });
  document.querySelectorAll('.days button').forEach(b => b.addEventListener('click', () => { sweep.day = b.dataset.day; setDayButtons(); setT(sweep.t); }));
  $('srcbtn').addEventListener('click', () => {
    // The "if the unmapped buildings were their estimated height" model is only computed when someone asks for the method.
    const d = days();
    if (sun && !sun.today.known && sun.today.ifEstimated === undefined) sun.today = K.groundSun(kit, d.today, { modelUnknown: true });
    if (sun && !sun.winter.known && sun.winter.ifEstimated === undefined) sun.winter = K.groundSun(kit, d.winter, { modelUnknown: true });
    renderSources(); $('sources').showModal();
  });
  $('cta').addEventListener('click', () => { track('cta', { cta: 'listing' }); $('ctaBox').showModal(); });
  $('explore').addEventListener('click', () => track('cta', { cta: 'explore' }));
  $('brand').addEventListener('click', () => track('cta', { cta: 'explore' }));

  // ---------- recorder hooks (used only by scripts/showhaus-listing-kit.mjs) ----------
  let idleFlag = true;
  window.__kit.frame = t => {
    idleFlag = false;
    map.jumpTo({ bearing: -25 + 100 * t, zoom: 17.4 + 0.3 * t });
    setT(0.03 + 0.94 * t); // sunrise+ → sunset−: the first and last minutes have no modelled shadow
    map.once('idle', () => { idleFlag = true; });
    map.triggerRepaint();
  };
  window.__kit.idle = () => idleFlag && (!map || (map.loaded() && map.areTilesLoaded()));

  boot();
})();
