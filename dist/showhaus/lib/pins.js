/* SHOWHAUS map: listing pins + the aircraft-noise lens, on top of the rent-terrain map (app.js).
   Pins: data/listings.json (scripts/showhaus_listings_build.py) — the off-the-plan project and the listing kits.
   Tapping a pin opens a small listing card that links to /l/<slug>.
   Noise lens: tints each pin by where SHOWHAUS's approximate ANEF 2039 / 2045 places it (computed at build time from contours
   kept private — the contours themselves are never published). Always labelled approx., never official. Waits for app.js's map (window.SHOWHAUS.map) and adds its layers after the map's own. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
  const INK = DARK ? '#ece4d3' : '#1d2733', PAPER = DARK ? '#15181d' : '#fffaf0';
  const PIN_COLOUR = ['match', ['get', 'kind'], 'off_the_plan', '#c4622d', '#2f4c7a'];
  const NOISE_COLOUR = y => ['match', ['get', `anef${y}`], 20, '#8fa8c8', 25, '#5f7fae', 30, '#3b5c91', 35, '#22396a', DARK ? '#5d6670' : '#c9cfd6'];
  const state = { listings: [], noise: false, year: 2039, open: null, ready: false };
  const track = (name, props) => { try { window.SH && window.SH.track(name, props); } catch { /* never breaks the map */ } };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pageUrl = slug => new URL(`./l/${slug}`, document.baseURI).href;

  async function load() {
    const l = await fetch('./data/listings.json').then(r => r.ok ? r.json() : null).catch(() => null);
    state.listings = (l && l.listings) || [];
  }
  const pinsFC = () => ({ type: 'FeatureCollection', features: state.listings.map(L => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: L.lnglat },
    properties: { slug: L.slug, name: L.name, kind: L.kind, world: L.world,
      anef2039: (L.anef && L.anef['2039']) ?? 0, anef2045: (L.anef && L.anef['2045']) ?? 0 } })) });

  function addLayers(map) {
    if (state.ready || !map.isStyleLoaded()) return;
    state.ready = true;
    map.addSource('listings', { type: 'geojson', data: pinsFC() });
    map.addLayer({ id: 'listing-halo', type: 'circle', source: 'listings', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 9, 15, 15], 'circle-color': PAPER, 'circle-opacity': .95 } });
    map.addLayer({ id: 'listing-pin', type: 'circle', source: 'listings', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 15, 10],
      'circle-color': PIN_COLOUR,
      'circle-stroke-color': INK, 'circle-stroke-width': 1.5 } });
    map.addLayer({ id: 'listing-name', type: 'symbol', source: 'listings', minzoom: 12, layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 1.6 } });
    const open = e => { const f = e.features && e.features[0]; if (f) { e.originalEvent && (e.originalEvent.__showhausPin = true); openCard(f.properties.slug, 'map'); } };
    map.on('click', 'listing-pin', open);
    map.on('click', 'listing-halo', open);
    map.on('mouseenter', 'listing-pin', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'listing-pin', () => { map.getCanvas().style.cursor = ''; });
  }

  // ---------- the listing card ----------
  function openCard(slug, via = 'map') {
    const L = state.listings.find(x => x.slug === slug);
    if (!L) return;
    state.open = slug;
    const box = $('pinCard');
    const kind = L.kind === 'off_the_plan' ? 'Off the plan · approved, not built' : `For rent · postcode ${esc(L.postcode)}`;
    const fact = L.kind === 'off_the_plan' ? `${esc(L.facts.towers)} buildings, ${esc(L.facts.apartments_consent)} apartments (consent)`
      : L.facts.rent_median_week ? `Postcode median $${Number(L.facts.rent_median_week).toLocaleString('en-AU')}/wk (new leases, 12 months)` : '';
    const walk = L.world === 'baked' ? 'Walk built, opening once it looks real' : 'No walk yet';
    box.innerHTML = `<button type="button" class="pc-x" aria-label="Close">×</button>
      <p class="pc-kind">${kind}</p>
      <h2>${esc(L.name)}</h2>
      <p class="pc-addr">${esc(L.address)}</p>
      <dl><div><dt>Aircraft noise</dt><dd>${esc(L.noise)}</dd></div>${fact ? `<div><dt>Records</dt><dd>${fact}</dd></div>` : ''}<div><dt>3D</dt><dd>${walk}</dd></div></dl>
      <a class="pc-open" href="${esc(pageUrl(L.slug))}">Open this property</a>`;
    box.hidden = false;
    box.querySelector('.pc-x').onclick = closeCard;
    box.querySelector('.pc-open').focus({ preventScroll: true });
    track('place_card', { kind: 'listing:' + L.slug, cta: via });
  }
  function closeCard() { state.open = null; $('pinCard').hidden = true; }

  // ---------- the noise lens ----------
  function paintPins() {
    const map = window.SHOWHAUS && window.SHOWHAUS.map;
    if (map && state.ready) map.setPaintProperty('listing-pin', 'circle-color', state.noise ? NOISE_COLOUR(state.year) : PIN_COLOUR);
  }
  function setNoise(on, { user = true } = {}) {
    state.noise = on;
    paintPins();
    $('noiseLens').setAttribute('aria-pressed', String(on));
    $('noiseKey').hidden = !on;
    document.body.classList.toggle('noise-on', on);
    if (user) track('cta', { cta: 'noise_lens', step: on ? 'on' : 'off' });
  }
  function setYear(y) {
    state.year = y;
    paintPins();
    document.querySelectorAll('#noiseKey [data-year]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.year) === y)));
  }

  function mountUi() {
    const lens = document.createElement('button');
    lens.type = 'button'; lens.id = 'noiseLens'; lens.className = 'noise-lens'; lens.setAttribute('aria-pressed', 'false');
    lens.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M2 12c3-5 13-5 16 0" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 15c2-3 8-3 10 0" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="17" r="1.4" fill="currentColor"/></svg><span>Aircraft noise</span>';
    lens.onclick = () => setNoise(!state.noise);
    const key = document.createElement('div');
    key.id = 'noiseKey'; key.className = 'noise-key'; key.hidden = true;
    key.innerHTML = `<div class="nk-years" role="group" aria-label="Forecast year"><button type="button" data-year="2039" aria-pressed="true">ANEF 2039</button><button type="button" data-year="2045" aria-pressed="false">ANEF 2045</button></div>
      <p><b>Approx.</b> Each pin is coloured by where SHOWHAUS's digitised copy of Sydney Airport's Master Plan 2045 map (Map 15-2) places it, to about ±300 m. Grey = outside ANEF 20. Not the official ANEF.</p>
      <div class="nk-scale" aria-hidden="true"><i style="background:#8fa8c8"></i>20<i style="background:#5f7fae"></i>25<i style="background:#3b5c91"></i>30<i style="background:#22396a"></i>35+</div>`;
    key.addEventListener('click', e => { const b = e.target.closest('[data-year]'); if (b) setYear(Number(b.dataset.year)); });
    const card = document.createElement('aside');
    card.id = 'pinCard'; card.className = 'pin-card'; card.hidden = true; card.setAttribute('aria-live', 'polite');
    document.body.append(lens, key, card);
    addEventListener('keydown', e => { if (e.key === 'Escape' && state.open) closeCard(); });
  }

  async function boot() {
    await load();
    mountUi();
    for (let i = 0; i < 400; i++) {
      const map = window.SHOWHAUS && window.SHOWHAUS.map;
      if (map) {
        if (map.isStyleLoaded()) addLayers(map); else map.once('idle', () => addLayers(map));
        map.on('styledata', () => addLayers(map));
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  window.SHOWHAUS_PINS = { state, openCard, closeCard, setNoise, setYear };
  boot();
})();
