/* SHOWHAUS app. Acts → HUD. Every number is counted from records, fetched live, or labelled est. */
(() => {
  'use strict';
  const C = window.ShowhausCore, SG = window.AtlasShadowGeometry;
  const $ = id => document.getElementById(id);
  const body = document.body;
  const SYD = [151.05, -33.86];
  const STORE = 'showhaus.v1';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } },
    set(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode: presets stay in memory */ } },
  };
  const API = {
    canopy: 'https://mapprod2.environment.nsw.gov.au/arcgis/rest/services/UHGC/GSR_2024_VegStrata_H3Z11/MapServer/0/query',
    land: 'https://mapprod2.environment.nsw.gov.au/arcgis/rest/services/EPA/Contaminated_land_notified_sites/FeatureServer/0/query',
    zoning: 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer/2/query',
    bushfire: 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/229/query',
    flood: 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/230/query',
    anec: 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Protection/MapServer/2/query',
  };
  const ROAD_RANK = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, minor: 1, service: 0 };
  const BEDS = [[0, 'Studio'], [1, '1 bed'], [2, '2 bed'], [3, '3 bed'], [4, '4+ bed']];
  const TYPES = [[0, 'Unit'], [1, 'House'], [2, 'Townhouse']];
  const DARK = document.documentElement.dataset.theme === 'dark', INK = DARK ? '#ece4d3' : '#202c2b', PAPER = DARK ? '#15181d' : '#f6f3ec';
  const RAMP = ['#f3e3c0', '#e8b974', '#d98a45', '#c4622d', '#9a3d22', '#5e2416'];

  const state = { display: store.get().display === 'numbers' ? 'numbers' : 'visual', act: 1, place: null, mode: 'rent', maxRent: null, beds: new Set(), types: new Set(), wants: {}, commute: null, lens: 'map', point: null, tab: 'rent', pin: null };
  let PRO = false; // set from the signed-in account (/api/auth/me → pro); everyone else sees Pro previewed blurred
  let A = null, centroids = {}, R = null, P = null, suburbs = [], pcFC = null, map = null, mapReady = false, pcIndexOf = new Map();
  const evidence = new Map();

  // ---------- data ----------
  async function loadData() {
    const [pr, rr, ar] = await Promise.all([fetch('./data/places.json'), fetch('./data/rents.json'), fetch('./data/amenities.json').catch(() => null)]);
    if (!pr.ok || !rr.ok) throw new Error('records unavailable (' + (pr.ok ? rr.status : pr.status) + ')');
    [P, R] = await Promise.all([pr.json(), rr.json()]);
    A = ar && ar.ok ? await ar.json() : null; // per-postcode measures; without them, area wants say "not measured yet"
    centroids = Object.fromEntries(P.postcodes.map(p => [p.pc, p.c]));
    R.postcodes.forEach((pc, i) => pcIndexOf.set(pc, i));
    const perPc = new Array(R.postcodes.length).fill(0);
    for (let i = 0; i < R.pc.length; i++) perPc[R.pc[i]]++;
    R.perPc = perPc;
    R.start = new Array(R.postcodes.length).fill(-1); R.end = new Array(R.postcodes.length).fill(-1);
    for (let i = 0; i < R.pc.length; i++) { if (R.start[R.pc[i]] < 0) R.start[R.pc[i]] = i; R.end[R.pc[i]] = i + 1; }
    const subs = P.suburbs.map(([name, postcode, lat, lng]) => ({ kind: 'suburb', name, postcode, lat, lng, pcis: [pcIndexOf.get(Number(postcode))] }))
      .filter(s => s.pcis[0] != null);
    const cent = new Map(P.postcodes.map(p => [p.pc, p.c]));
    const areas = P.areas.map(a => {
      const pcis = a.pcs.map(pc => pcIndexOf.get(pc)).filter(x => x != null);
      const pts = a.pcs.map(pc => cent.get(pc)).filter(Boolean);
      const bbox = pts.length ? [Math.min(...pts.map(c => c[0])), Math.min(...pts.map(c => c[1])), Math.max(...pts.map(c => c[0])), Math.max(...pts.map(c => c[1]))] : null;
      return { kind: a.kind, name: a.name, aliases: a.aliases, pcis, bbox, lat: bbox ? (bbox[1] + bbox[3]) / 2 : null, lng: bbox ? (bbox[0] + bbox[2]) / 2 : null };
    }).filter(a => a.pcis.length && a.bbox);
    suburbs = [...areas, ...subs].map((x, i) => ({ ...x, i, pci: x.pcis[0], n: x.pcis.reduce((t, k) => t + (perPc[k] || 0), 0) }));
    pcFC = { type: 'FeatureCollection', features: P.postcodes.filter(p => pcIndexOf.has(p.pc)).map(p => ({ type: 'Feature', id: p.pc, geometry: p.g, properties: { pc: p.pc, pci: pcIndexOf.get(p.pc), med: 0, n: 0, h: 0, sel: 0 } })) };
    const last = R.months.at(-1), first = R.months[0];
    $('live').textContent = `${R.w.length.toLocaleString('en-AU')} leases · ${fmtYm(first)}–${fmtYm(last)}`;
    $('live').title = 'Every rental bond lodged with NSW Fair Trading. Built ' + R.generatedAt.slice(0, 10) + '. ' + R.sources.map(s => s.name + ' (' + s.licence + ')').join(' · ');
  }
  function pillImage() { // 64×64 stretchable rounded pill, drawn once; colours follow the theme the page loaded in
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
    g.beginPath(); g.roundRect(6, 6, 52, 52, 24); g.fillStyle = PAPER; g.fill();
    g.shadowColor = 'transparent'; g.lineWidth = 2; g.strokeStyle = INK; g.globalAlpha = .9; g.stroke();
    return g.getImageData(0, 0, 64, 64);
  }
  // Discrete, source-backed quantity bars. Not individual property positions.
  function meterImage(level) {
    const c = document.createElement('canvas'); c.width = 160; c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = PAPER; g.strokeStyle = INK; g.lineWidth = 1.3;
    g.beginPath(); g.roundRect(2, 2, 156, 44, 11); g.fill(); g.stroke();
    for (let i = 0; i < 5; i++) {
      g.fillStyle = i < level ? (DARK ? '#b6cbbe' : '#48695f') : (DARK ? '#444e52' : '#d7dcd6');
      g.beginPath(); g.roundRect(13 + i * 27, 12, 21, 24, 3); g.fill();
    }
    return g.getImageData(0, 0, c.width, c.height);
  }
  function pcNodes() {
    return { type: 'FeatureCollection', features: (pcFC?.features || []).filter(f => f.properties.n > 0 && centroids[f.properties.pc])
      .map(f => ({ type: 'Feature', properties: { pc: f.properties.pc, n: f.properties.n, med: f.properties.med }, geometry: { type: 'Point', coordinates: centroids[f.properties.pc] } })) };
  }
  // One capsule per visible cluster, labelled with its summed *lease* count, not
  // MapLibre's point_count (which would count postcodes). Round only the label.
  const leases = ['case', ['has', 'leases'], ['get', 'leases'], ['get', 'n']];
  const meterLevel = ['step', leases, 1, 2, 2, 10, 3, 100, 4, 1000, 5];
  const roundedLeases = ['case',
    ['<', leases, 10], ['to-string', leases],
    ['<', leases, 100], ['concat', '≈', ['to-string', ['*', 10, ['round', ['/', leases, 10]]]]],
    ['<', leases, 1000], ['concat', '≈', ['to-string', ['*', 100, ['round', ['/', leases, 100]]]]],
    ['<', leases, 10000], ['concat', '≈', ['to-string', ['/', ['round', ['/', leases, 100]], 10]], 'k'],
    ['concat', '≈', ['to-string', ['round', ['/', leases, 1000]]], 'k']
  ];
  const fmtYm = ym => new Date(Date.UTC(Math.floor(ym / 100), ym % 100 - 1, 1)).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  // ---------- map ----------
  function mapUnavailable(message = 'The interactive map is unavailable in this browser. Rent search, counts and postcode evidence still work; try a WebGL-capable browser for map interaction.') {
    const status = $('mapStatus');
    status.dataset.state = 'error';
    status.textContent = message;
  }
  function syncMapPadding() {
    if (!map) return;
    const mobile = innerWidth <= 760;
    map.setPadding(mobile
      ? { top: 64, right: 10, bottom: Math.round(innerHeight * (state.act === 4 ? .49 : Math.min(.56, 520 / innerHeight))) + 78, left: 10 }
      : { top: 85, right: state.act === 4 ? Math.min(380, Math.round(innerWidth * .3)) : 18,
          bottom: 28, left: innerWidth <= 1100 ? 362 : Math.min(442, Math.round(innerWidth * .29) + 58) });
  }
  function initMap() {
    try {
      map = new maplibregl.Map({
        container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: SYD, zoom: 9.6, pitch: 0,
        attributionControl: { compact: true }, maxBounds: [[139.5, -38.5], [155.5, -27.0]],
      });
    } catch (e) {
      map = null;
      mapUnavailable();
      console.warn('SHOWHAUS map initialization unavailable:', e.message);
      return;
    }
    setTimeout(() => { if (!mapReady) mapUnavailable(); }, 12000);
    map.on('load', () => {
      $('mapStatus').dataset.state = 'ready';
      tintBasemap();
      const before = map.getLayer('building') ? 'building' : undefined;
      map.addSource('pc', { type: 'geojson', data: pcFC || { type: 'FeatureCollection', features: [] }, promoteId: 'pc' });
      map.addLayer({ id: 'pc-fill', type: 'fill', source: 'pc', paint: {
        'fill-color': ['case', ['==', ['get', 'n'], 0], 'rgba(0,0,0,0)', ['interpolate', ['linear'], ['get', 'med'], 350, RAMP[0], 550, RAMP[1], 750, RAMP[2], 950, RAMP[3], 1300, RAMP[4], 2000, RAMP[5]]],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, .32, 11.2, .34, 12.2, .22, 16, .14] } }, before);
      map.addLayer({ id: 'pc-line', type: 'line', source: 'pc', paint: { 'line-color': '#2f4c7a', 'line-opacity': ['case', ['==', ['get', 'sel'], 1], .95, .16], 'line-width': ['case', ['==', ['get', 'sel'], 1], 2.4, .6] } });
      map.addLayer({ id: 'pc-3d', type: 'fill-extrusion', source: 'pc', layout: { visibility: 'none' }, paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'med'], 350, RAMP[0], 550, RAMP[1], 750, RAMP[2], 950, RAMP[3], 1300, RAMP[4], 2000, RAMP[5]],
        'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': .82 } });
      // Cluster postcode aggregates, NEVER individual lease locations: the source has only
      // postcode centroids. Sum actual lease records, not the number of source postcodes.
      // Show more postcode nodes at overview zoom without restoring individual lease dots.
      map.addSource('pcn', { type: 'geojson', data: pcNodes(), cluster: true, clusterRadius: 46,
        clusterMaxZoom: 10, clusterProperties: { leases: ['+', ['get', 'n']] } });
      // Collision-managed quantity capsules: one readable marker per cluster at this zoom.
      for (let n = 1; n <= 5; n++) map.addImage('lease-meter-' + n, meterImage(n), { pixelRatio: 2 });
      map.addImage('pill', pillImage(), { pixelRatio: 2, stretchX: [[28, 36]], stretchY: [[28, 36]], content: [20, 12, 44, 52] });
      map.addLayer({ id: 'pc-nodes-n', type: 'symbol', source: 'pcn', layout: {
        'text-field': roundedLeases, 'text-font': ['Noto Sans Bold'],
        'text-size': ['step', leases, 12, 10, 13, 100, 14, 1000, 15, 10000, 17],
        'icon-image': 'pill', 'icon-text-fit': 'both', 'icon-text-fit-padding': [3, 9, 3, 9],
        'symbol-sort-key': ['-', leases], 'text-padding': 15, 'icon-padding': 15, visibility: 'none' },
        paint: { 'text-color': INK } });
      map.addLayer({ id: 'pc-nodes-v', type: 'symbol', source: 'pcn', layout: {
        'icon-image': ['concat', 'lease-meter-', ['to-string', meterLevel]],
        'icon-padding': 13, 'symbol-sort-key': ['-', leases]
      } });
      map.addSource('pick', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'pick-road', type: 'line', source: 'pick', filter: ['==', ['get', 'k'], 'road'], paint: { 'line-color': '#2f4c7a', 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'pick-ring', type: 'line', source: 'pick', filter: ['==', ['get', 'k'], 'ring'], paint: { 'line-color': '#7d5fc7', 'line-width': 1.2, 'line-opacity': .7 } });
      map.addLayer({ id: 'pick-land', type: 'circle', source: 'pick', filter: ['==', ['get', 'k'], 'land'], paint: { 'circle-radius': 5, 'circle-color': '#8a4b2a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
      map.addLayer({ id: 'pick-pin', type: 'circle', source: 'pick', filter: ['==', ['get', 'k'], 'pin'], paint: { 'circle-radius': 8, 'circle-color': '#7d5fc7', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'pick-sun', type: 'line', source: 'pick', filter: ['==', ['get', 'k'], 'sun'], paint: { 'line-color': '#e2a234', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
      mapReady = true;
      syncMapPadding();
      applyFilter();
      setDisplay(state.display);
      renderNearby();
    });
    map.on('moveend', () => { renderLegend(); renderNearby(); });
    const expandNode = async e => {
      const f = e.features[0]; if (!f) return;
      let zoom = Math.max(map.getZoom(), 12.5);
      if (f.properties.cluster && Number.isInteger(f.properties.cluster_id)) {
        try { zoom = Math.max(map.getZoom() + 1, await map.getSource('pcn').getClusterExpansionZoom(f.properties.cluster_id)); }
        catch (err) { console.warn('Cluster expansion unavailable:', err.message); }
      }
      map.easeTo({ center: f.geometry.coordinates, zoom, duration: 650 });
    };
    for (const layer of ['pc-nodes-n', 'pc-nodes-v']) {
      map.on('click', layer, expandNode);
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    map.on('mousemove', 'pc-fill', e => {
      const f = e.features[0]; if (!f) return;
      map.getCanvas().style.cursor = 'pointer';
      const pr = f.properties;
      pop.setLngLat(e.lngLat).setHTML(`<b>${String(pr.pc).padStart(4, '0')}</b> · ${pr.n ? `${C.weekly(pr.med)} median · ${Number(pr.n).toLocaleString('en-AU')} leases` : 'no matching leases'}`).addTo(map);
    });
    map.on('mouseleave', 'pc-fill', () => { map.getCanvas().style.cursor = ''; pop.remove(); });
    map.on('click', e => {
      // A quantity capsule drills into the aggregation; it is not an exact-address pin.
      if (map.queryRenderedFeatures(e.point, { layers: ['pc-nodes-n', 'pc-nodes-v'] }).length) return;
      if (state.act < 3) {
        const f = map.queryRenderedFeatures(e.point, { layers: ['pc-fill'] })[0];
        if (f && state.act === 1) { const s = suburbs.filter(x => x.pci === f.properties.pci).sort((a, b) => b.n - a.n)[0]; if (s) choosePlace(s); }
        return;
      }
      selectPoint({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    });
    map.on('move', drawOverlay);
    map.on('error', e => {
      mapUnavailable('Some map tiles are unavailable. Rental records and filters still work; try reloading the map later.');
      if (!mapReady) toast('Map tiles could not load: ' + (e.error?.message || 'unknown'));
    });
  }
  function tintBasemap() {
    const css = getComputedStyle(document.documentElement);
    const paper = css.getPropertyValue('--paper').trim(), dark = DARK;
    const set = (id, p, v) => { try { if (map.getLayer(id)) map.setPaintProperty(id, p, v); } catch { /* layer differs */ } };
    set('background', 'background-color', paper);
    set('water', 'fill-color', dark ? '#1c2a36' : '#c9d8de');
    set('park', 'fill-color', dark ? '#1e2a20' : '#dfe3c8');
    set('landuse_residential', 'fill-color', dark ? '#1a1d22' : '#e9dfcb');
    set('building', 'fill-color', dark ? '#262b33' : '#e0d2b8');
  }

  // ---------- filter & counters ----------
  let allowedCache = { key: null, v: { allowed: null, unknown: 0 } };
  function allowed() {
    const key = JSON.stringify([state.wants, state.commute, !!A]);
    if (allowedCache.key !== key) allowedCache = { key, v: C.allowedPostcodes(R.postcodes, A?.postcodes, A ? state.wants : { commute: state.wants.commute }, { commute: state.commute, centroids }) };
    return allowedCache.v;
  }
  const filters = (withPlace = true) => ({
    pcSet: (() => {
      const al = allowed().allowed;
      const base = withPlace && state.place ? state.place.pcis : null;
      if (!al) return base ? new Set(base) : null;
      return new Set((base || R.postcodes.map((_, i) => i)).filter(i => al.has(i)));
    })(),
    maxRent: state.mode === 'rent' ? state.maxRent : null,
    beds: state.beds.size ? state.beds : null, types: state.types.size ? state.types : null,
  });
  function currentIdx() {
    if (!R) return [];
    const f = filters(true);
    if (!f.pcSet) return C.filterRents(R, f);
    const out = []; // rows are grouped by postcode: scan only the chosen postcode's slice
    for (const pi of f.pcSet) for (let i = R.start[pi]; i < R.end[pi]; i++) {
      if (f.maxRent != null && R.w[i] > f.maxRent) continue;
      if (f.beds && !f.beds.has(R.b[i] >= 4 ? 4 : R.b[i])) continue;
      if (f.types && !f.types.has(R.t[i])) continue;
      out.push(i);
    }
    return out;
  }
  let cityKey = null;
  function applyFilter() {
    if (!R) return [];
    const idx = currentIdx();
    // City-wide colouring uses the same bed/type/budget filter, so the whole map answers "where can I afford this?".
    const cf = filters(false), key = JSON.stringify([cf.maxRent, cf.beds && [...cf.beds].sort(), cf.types && [...cf.types].sort(), allowedCache.key]);
    if (key !== cityKey && pcFC) { // recolour the city only when bed/type/budget change, not on every keystroke
      cityKey = key;
      const per = R.postcodes.map(() => []);
      for (const i of C.filterRents(R, cf)) per[R.pc[i]].push(R.w[i]); // postcodes failing a want get no leases → unpainted
      for (const f of pcFC.features) {
        const v = per[f.properties.pci].sort((a, b) => a - b);
        f.properties.n = v.length; f.properties.med = C.quantile(v, .5) || 0; f.properties.h = v.length ? (f.properties.med - 200) * 6 : 0;
      }
    }
    const selSet = state.place ? new Set(state.place.pcis) : null;
    if (pcFC) for (const f of pcFC.features) f.properties.sel = selSet && selSet.has(f.properties.pci) ? 1 : 0;
    if (mapReady) { map.getSource('pc').setData(pcFC); map.getSource('pcn').setData(pcNodes()); }
    const rents = idx.map(i => R.w[i]).sort((a, b) => a - b);
    $('c1').textContent = idx.length.toLocaleString('en-AU');
    $('c2').textContent = state.mode === 'buy' ? '—' : idx.length.toLocaleString('en-AU');
    $('m2').textContent = state.mode === 'buy' ? 'licence pending' : C.weekly(C.quantile(rents, .5));
    $('c3').textContent = state.mode === 'buy' ? '—' : idx.length.toLocaleString('en-AU');
    $('summaryCount').textContent = state.mode === 'buy' ? '—' : idx.length.toLocaleString('en-AU');
    $('summaryMedian').textContent = state.mode === 'buy' ? 'licence pending' : C.weekly(C.quantile(rents, .5));
    syncPriceLabels(); renderLegend();
    renderSelection();
    drawOverlay();
    return idx;
  }

  // ---------- act 1 ----------
  function setDisplay(which) {
    state.display = which === 'numbers' ? 'numbers' : 'visual';
    const next = store.get(); next.display = state.display; store.set(next);
    document.querySelectorAll('[data-display]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.display === state.display)));
    if (mapReady) {
      map.setLayoutProperty('pc-nodes-n', 'visibility', state.display === 'numbers' ? 'visible' : 'none');
      map.setLayoutProperty('pc-nodes-v', 'visibility', state.display === 'visual' ? 'visible' : 'none');
    }
    renderLegend();
  }
  function renderNearby() {
    const wrapper = $('nearby'), list = $('nearbyList');
    if (!mapReady || !R || $('where').value.trim() || state.act !== 1) { wrapper.hidden = true; return; }
    // Use the visible map (excluding the panel), never device geolocation.
    const shell = document.querySelector('.explore-shell').getBoundingClientRect();
    const canvas = map.getCanvas().getBoundingClientRect();
    const mobile = innerWidth <= 760;
    const x = mobile ? canvas.width / 2 : (Math.min(canvas.width, shell.right - canvas.left + 18) + canvas.width) / 2;
    const y = mobile ? Math.max(80, (shell.top - canvas.top + 68) / 2) : canvas.height / 2;
    const left = mobile ? 8 : shell.right - canvas.left + 8;
    const bottom = mobile ? shell.top - canvas.top - 8 : canvas.height - 12;
    const visible = suburbs.filter(s => s.kind === 'suburb' && s.n > 0 && Number.isFinite(s.lng) && Number.isFinite(s.lat))
      .map(s => { const p = map.project([s.lng, s.lat]); return { s, x: p.x, y: p.y, d: Math.hypot(p.x - x, p.y - y) }; })
      .filter(v => v.x >= left && v.x <= canvas.width - 10 && v.y >= 78 && v.y <= bottom)
      .sort((a, b) => a.d - b.d || b.s.n - a.s.n);
    const used = new Set(), picks = [];
    for (const v of visible) {
      if (used.has(v.s.postcode)) continue;
      used.add(v.s.postcode); picks.push(v.s);
      if (picks.length === 4) break;
    }
    wrapper.hidden = !picks.length;
    list.innerHTML = picks.map(s => `<button type="button" data-i="${s.i}" title="Nearby in your current map view, not a quality ranking"><strong>${esc(s.name)}</strong><small>NSW ${esc(s.postcode)}</small></button>`).join('');
  }
  let sugg = [], suggPick = 0, suggestion = null;
  function onWhere() {
    const raw = $('where').value, r = C.searchSuburbs(suburbs, raw), q = r.query;
    sugg = r.matches; suggPick = 0; suggestion = r.suggestion || null;
    const hint = $('whereHint');
    if (q.kind === 'empty') { hint.textContent = ''; renderPresets(true); }
    else renderPresets(false);
    if (q.kind === 'short') hint.textContent = 'Keep typing — 3 letters or a 4-digit postcode.';
    else if (q.kind === 'price') hint.innerHTML = `That looks like a budget (${q.value < 10000 ? C.weekly(q.value) : C.money(q.value)}). It goes in the next step — <kbd>Enter</kbd> to keep it.`;
    else if (r.scope === 'elsewhere') hint.textContent = 'SHOWHAUS covers New South Wales for now — rental bond records outside NSW are held by other states.';
    else if (q.kind === 'text' && !sugg.length) hint.innerHTML = suggestion ? `No suburb called “${esc(raw)}”. Did you mean <b>${esc(suggestion.name)}</b>? <kbd>Tab</kbd>` : `No NSW suburb, council or area matches “${esc(raw)}”.`;
    else if (q.kind === 'postcode' && !sugg.length) hint.textContent = `Postcode ${q.value} has no NSW rental bond records.`;
    else if (sugg.length) hint.textContent = r.scope === 'postcode' ? `Postcode ${q.value}: ${sugg.length} suburb${sugg.length > 1 ? 's' : ''}` : r.scope === 'exact' ? 'Exact match' : 'Close matches';
    $('suggest').innerHTML = sugg.map((s, k) => `<li><button type="button" role="option" data-i="${s.i}" aria-selected="${k === 0}">${esc(s.name)}<small>${placeTag(s)}</small></button></li>`).join('');
    renderNearby();
    const top = sugg[0];
    state.place = top || null;
    applyFilter();
    if (top && mapReady) flyToPlace(top);
    else if (!top && mapReady && q.kind === 'empty') map.easeTo({ center: SYD, zoom: 9.6, duration: 500 });
    $('c1label').textContent = top ? `new leases in ${top.kind === 'suburb' ? top.postcode : top.name}, last 12 months` : 'new leases lodged in NSW, last 12 months';
  }
  const KIND = { state: 'state', metro: 'metro area', region: 'ABS region', council: 'council', everyday: 'as commonly used' };
  const placeTag = s => s.kind === 'suburb' ? s.postcode : `${KIND[s.kind]} · ${s.pcis.length} postcode${s.pcis.length > 1 ? 's' : ''}`;
  function flyToPlace(s) {
    if (s.kind === 'suburb' || !s.bbox) return map.easeTo({ center: [s.lng, s.lat], zoom: 12.6, duration: 500 });
    const [w, so, e, n] = s.bbox, pad = Math.max(0.01, (e - w) * 0.08);
    map.fitBounds([[w - pad, so - pad], [e + pad, n + pad]], { padding: { top: 90, bottom: 280, left: 40, right: 40 }, maxZoom: 13, duration: 600 });
  }
  function choosePlace(s) {
    state.place = s; $('where').value = s.name; remember(s); applyFilter(); if (mapReady) flyToPlace(s); go(2);
    window.SH && SH.track('search', { kind: s.kind, postcode: s.postcode });
  }
  function remember(s) {
    const st = store.get(); const list = (st.recent || []).filter(x => x.name !== s.name);
    list.unshift({ name: s.name, postcode: s.postcode || null, kind: s.kind }); st.recent = list.slice(0, 6); store.set(st);
  }
  const byName = (name, pc) => suburbs.find(s => s.name === name && (s.postcode || null) === (pc || null));
  function renderPresets(show) {
    const list = show ? (store.get().recent || []).filter(p => byName(p.name, p.postcode)) : [];
    $('presets').innerHTML = list.map(p => `<li><button class="go" type="button" data-name="${esc(p.name)}" data-pc="${p.postcode || ''}">${esc(p.name)}</button><button class="x" type="button" data-x="${esc(p.name)}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join('');
  }

  // ---------- act 2 ----------
  const RENT_STEPS = (() => { const a = []; for (let v = 250; v <= 1500; v += 25) a.push(v); for (let v = 1600; v <= 3000; v += 100) a.push(v); return a; })();
  function setBudgetFromSlider() {
    const k = Number($('budget').value);
    state.maxRent = k >= RENT_STEPS.length ? null : RENT_STEPS[k];
    $('budgetValue').textContent = state.maxRent ? C.weekly(state.maxRent) : 'no limit';
    applyFilter();
  }
  function setMode(m) {
    state.mode = m;
    document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
    const buy = m === 'buy';
    $('budget').disabled = buy; $('rentHint').hidden = !buy;
    $('budgetLabel').textContent = buy ? 'Sale price' : 'Rent up to';
    if (buy) $('budgetValue').textContent = 'not available';
    else setBudgetFromSlider();
    $('rentHint').textContent = "Sold prices aren't on SHOWHAUS yet: NSW sales records need a commercial licence we haven't got. Everything else below still works for buyers.";
    cue(); applyFilter();
  }
  function renderFacets() {
    $('beds').innerHTML = BEDS.map(([v, l]) => `<button type="button" data-bed="${v}" aria-pressed="${state.beds.has(v)}">${l}</button>`).join('');
    $('types').innerHTML = TYPES.map(([v, l]) => `<button type="button" data-type="${v}" aria-pressed="${state.types.has(v)}">${l}</button>`).join('');
  }

  // ---------- act 3 ----------
  function renderWants() {
    $('wants').innerHTML = Object.entries(C.WANTS).map(([k, w]) => {
      const note = w.scope === 'home' ? `<small>checked at each home${PRO ? '' : ' · Pro'}</small>` : !A && !w.custom ? '<small>not measured yet</small>' : '';
      return `<button type="button" data-want="${k}" aria-pressed="${!!state.wants[k]}">${esc(w.label)}${note}<span class="hair"></span></button>`;
    }).join('');
    $('commuteBox').hidden = !state.wants.commute;
    const al = allowed();
    $('wantsHint').textContent = al.allowed
      ? `${al.allowed.size} of ${R.postcodes.length} postcodes fit${al.unknown ? ` · ${al.unknown} not measured, left out` : ''} — “most neighbourhoods” means over half.`
      : 'Area choices narrow the map and the count; “at each home” choices are checked on the place card.';
  }
  function toggleWant(k) {
    state.wants[k] = !state.wants[k];
    if (!state.wants[k]) delete state.wants[k];
    if (k === 'commute' && state.wants[k]) setTimeout(() => $('commuteWhere').focus(), 30);
    cue(); applyFilter(); renderWants();
  }
  let commuteTimer = null;
  async function geocodeCommute() {
    const q = $('commuteWhere').value.trim(), km = Number($('commuteKm').value);
    $('commuteKmLabel').textContent = km + ' km';
    if (q.length < 3) { state.commute = null; applyFilter(); renderWants(); return; }
    // A suburb, council or area we already know is resolved locally; anything else asks OpenStreetMap Nominatim (NSW only).
    const local = C.searchSuburbs(suburbs, q).matches[0];
    let hit = local && local.kind === 'suburb' ? { lat: local.lat, lng: local.lng, label: local.name } : null;
    if (!hit) {
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: q + ', NSW, Australia', format: 'jsonv2', limit: '1', countrycodes: 'au' }), { headers: { Accept: 'application/json' } });
        const d = await r.json(); if (d[0]) hit = { lat: Number(d[0].lat), lng: Number(d[0].lon), label: d[0].display_name.split(',')[0] };
      } catch { /* offline: say so below */ }
    }
    state.commute = hit ? { ...hit, km } : null;
    $('commuteHint').textContent = hit ? `Straight-line distance from each postcode's centre to ${hit.label} — not travel time.` : `Couldn't find “${q}” in NSW.`;
    applyFilter(); renderWants();
  }
  function demoChip() { const b = $('wants').querySelector('button'); if (!b) return; b.classList.add('demo'); setTimeout(() => b.classList.remove('demo'), 1100); }

  // ---------- acts ----------
  function go(n) {
    if (n > 1 && !state.place) { n = 1; toast('Pick a suburb first.'); }
    state.act = n; body.dataset.act = String(n);
    document.querySelectorAll('.cuts li').forEach(li => {
      const c = Number(li.dataset.cut);
      li.classList.toggle('on', c === n); li.classList.toggle('done', c < n); li.classList.toggle('locked', c > 1 && !state.place);
    });
    if (n === 1) { renderNearby(); setTimeout(() => $('where').focus(), 50); }
    if (n === 2) {
      renderFacets();
      if (state.pendingBudget) { const k = RENT_STEPS.findIndex(v => v >= state.pendingBudget); $('budget').value = String(k < 0 ? RENT_STEPS.length - 1 : k); state.pendingBudget = null; setBudgetFromSlider(); }
      setTimeout(() => $('budget').focus(), 50);
    }
    if (n === 3) { renderWants(); setTimeout(demoChip, 400); }
    if (n === 4) {
      $('q4').textContent = state.place?.kind === 'suburb'
        ? `${state.place.name} NSW ${state.place.postcode}` : (state.place?.name || 'Explore Sydney');
      if (!state.point && state.place) {
        if (state.place.kind === 'suburb') selectPoint({ lng: state.place.lng, lat: state.place.lat });
        else { // a broad area: start at its busiest postcode's centre
          const top = state.place.pcis.slice().sort((a, b) => R.perPc[b] - R.perPc[a])[0], c = P.postcodes.find(p => p.pc === R.postcodes[top])?.c;
          selectPoint(c ? { lng: c[0], lat: c[1] } : { lng: state.place.lng, lat: state.place.lat });
        }
      } else renderCard();
    }
    syncMapPadding();
    cue(); renderSelection();
  }

  // ---------- selection line ----------
  function renderSelection() {
    const toks = C.selectionLine({ ...state, beds: [...state.beds].sort() });
    for (const t of state.types) toks.push({ key: 'type:' + t, text: TYPES.find(x => x[0] === t)[1].toLowerCase() });
    const says = state.act >= 2 && R && state.mode !== 'buy' ? `<span class="say">${currentIdx().length.toLocaleString('en-AU')} leases match</span>` : '';
    if (innerWidth < 760 && toks.length > 2) { const rest = toks.length - 1; toks.splice(1, toks.length, { key: 'more', text: `+${rest} filter${rest > 1 ? 's' : ''}` }); }
    $('selection').innerHTML = toks.map(t => `<span class="tok">${esc(t.text)}<button type="button" data-tok="${esc(t.key)}" aria-label="Remove ${esc(t.text)}">×</button></span>`).join('') + says;
  }
  function removeToken(key) {
    if (key === 'place') { state.place = null; state.point = null; $('where').value = ''; go(1); onWhere(); return; }
    if (key === 'more') { go(2); return; }
    if (key === 'mode') setMode('look');
    else if (key === 'maxRent') { $('budget').value = String(RENT_STEPS.length); setBudgetFromSlider(); }
    else if (key.startsWith('beds:')) state.beds.delete(Number(key.slice(5)));
    else if (key.startsWith('type:')) state.types.delete(Number(key.slice(5)));
    else if (key.startsWith('want:')) { const k = key.slice(5); delete state.wants[k]; if (k === 'commute') state.commute = null; renderWants(); }
    renderFacets(); applyFilter();
  }

  // ---------- place & evidence ----------
  const keyOf = p => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
  function pcAt(p) { const f = pcFC.features.find(f => C.pointInGeometry(p.lng, p.lat, f.geometry)); return f ? f.properties.pci : null; }
  function selectPoint(p) {
    p.pci = pcAt(p);
    state.point = p;
    const fw = $('flagWrong'); if (fw && fw.dataset.done) { delete fw.dataset.done; fw.textContent = 'Looks wrong?'; }
    if (state.act !== 4) go(4);
    const k = keyOf(p);
    if (!evidence.has(k)) evidence.set(k, { road: { s: 'load' }, sun: { s: 'load' }, canopy: { s: 'load' }, land: { s: 'load' }, plan: { s: 'load' } });
    if (!map || !mapReady) {
      evidence.set(k, { road: { s: 'err', why: 'Interactive map unavailable' }, sun: { s: 'err', why: 'Interactive map unavailable' }, canopy: { s: 'none' }, land: { s: 'none' }, plan: { s: 'none' } });
      renderCard();
      return;
    }
    map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 16.2), duration: 600 });
    renderCard(); drawPick();
    window.SH && SH.track('place_card', p.pci != null ? { postcode: String(R.postcodes[p.pci]).padStart(4, '0') } : undefined);
    map.once('idle', () => { measureLocal(p); renderCard(); drawPick(); drawOverlay(); });
    fetchCanopy(p); fetchLand(p); fetchPlanning(p);
  }
  function measureLocal(p) {
    const ev = evidence.get(keyOf(p));
    // Road: OSM transportation features already loaded for this view.
    try {
      const roads = map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' })
        .filter(f => f.geometry && /Line/.test(f.geometry.type) && f.properties.class in ROAD_RANK);
      if (!roads.length) ev.road = { s: 'err', why: 'no road geometry loaded at this zoom' };
      else {
        const best = {}, local = [];
        for (const f of roads) {
          const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
          const r = C.nearestOnLines(p, lines); if (!r) continue;
          const cls = f.properties.class;
          if (r.distance < 300 && local.length < 400) for (const l of lines) local.push({ cls, pts: l });
          if (!best.any || r.distance < best.any.distance) best.any = { ...r, cls, name: f.properties.name };
          if (ROAD_RANK[cls] >= 4 && (!best.major || r.distance < best.major.distance)) best.major = { ...r, cls, name: f.properties.name };
        }
        ev.road = { s: 'ok', any: best.any, major: best.major || null, local };
      }
    } catch (e) { ev.road = { s: 'err', why: e.message }; }
    // Sun: OSM buildings with render_height around the point (est.).
    try {
      const near = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' })
        .filter(f => f.geometry && /Polygon/.test(f.geometry.type))
        .filter(f => { const c = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0][0][0]; return C.metres(p, { lng: c[0], lat: c[1] }) < 240; });
      const seen = new Set(), all = near.filter(f => { const c = JSON.stringify(f.geometry.coordinates).slice(0, 80); if (seen.has(c)) return false; seen.add(c); return true; });
      // OpenFreeMap fills a default height for buildings without one; only explicit heights count as evidence.
      const uniq = all.filter(f => Number(f.properties.render_height) > 2).slice(0, 250);
      const today = sydneyToday(), winter = today.slice(0, 4) + '-06-21';
      ev.sun = { s: 'ok', n: uniq.length, total: all.length, today: C.sunMinutesAtPoint(p, uniq, today, SG.castBuilding), winter: C.sunMinutesAtPoint(p, uniq, winter, SG.castBuilding), day: today };
    } catch (e) { ev.sun = { s: 'err', why: e.message }; }
  }
  function arcgis(url, params) {
    const q = new URLSearchParams({ where: '1=1', f: 'json', inSR: '4326', outSR: '4326', ...params });
    return fetch(url + '?' + q, { signal: AbortSignal.timeout(15000) }).then(r => { if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); })
      .then(d => { if (d.error) throw Error(d.error.message || 'service error'); return d; });
  }
  function fetchCanopy(p) {
    const k = keyOf(p);
    arcgis(API.canopy, { geometry: `${p.lng},${p.lat}`, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', outFields: 'Canopy_pc,All_veg_pc,Suburb', returnGeometry: 'false' })
      .then(d => { const a = d.features?.[0]?.attributes; evidence.get(k).canopy = a ? { s: 'ok', canopy: a.Canopy_pc, veg: a.All_veg_pc, suburb: a.Suburb, at: new Date() } : { s: 'none' }; })
      .catch(e => { evidence.get(k).canopy = { s: 'err', why: e.message }; })
      .finally(() => { if (state.point && keyOf(state.point) === k) renderCard(); });
  }
  function fetchLand(p) {
    const k = keyOf(p), dLat = 1000 / 111320, dLng = 1000 / (111320 * Math.cos(p.lat * Math.PI / 180));
    arcgis(API.land, { geometry: [p.lng - dLng, p.lat - dLat, p.lng + dLng, p.lat + dLat].join(','), geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects', outFields: 'SiteName,ManagementClass,ContaminationActivityType', returnGeometry: 'true', resultRecordCount: '1000' })
      .then(d => {
        if (d.exceededTransferLimit) throw Error('result capped — count withheld');
        const sites = (d.features || []).map(f => ({ name: f.attributes.SiteName, cls: f.attributes.ManagementClass, act: f.attributes.ContaminationActivityType, lng: f.geometry.x, lat: f.geometry.y }))
          .map(s => ({ ...s, d: C.metres(p, s) })).filter(s => s.d <= 1000).sort((a, b) => a.d - b.d);
        evidence.get(k).land = { s: 'ok', sites, at: new Date() };
      })
      .catch(e => { evidence.get(k).land = { s: 'err', why: e.message }; })
      .finally(() => { if (state.point && keyOf(state.point) === k) { renderCard(); drawPick(); } });
  }
  function fetchPlanning(p) {
    const k = keyOf(p), pt = { geometry: `${p.lng},${p.lat}`, geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false' };
    const one = (url, fields) => arcgis(url, { ...pt, outFields: fields }).then(d => ({ ok: true, rows: (d.features || []).map(f => f.attributes) })).catch(e => ({ ok: false, why: e.message }));
    Promise.all([one(API.zoning, 'SYM_CODE,LAY_CLASS,EPI_NAME'), one(API.bushfire, 'd_Category,Category'), one(API.flood, 'LAY_CLASS,EPI_NAME,LGA_NAME'), one(API.anec, 'ANEF_CODE,EPI_NAME')])
      .then(([zoning, bushfire, flood, anec]) => { evidence.get(k).plan = { s: 'ok', zoning, bushfire, flood, anec, at: new Date() }; })
      .finally(() => { if (state.point && keyOf(state.point) === k) renderCard(); });
  }

  // ---------- card ----------
  const tag = t => `<span class="tag ${t}">${t === 'est' ? 'est.' : t}</span>`;
  function renderCard() {
    const p = state.point; if (!p) return;
    const ev = evidence.get(keyOf(p)) || {};
    const pc = p.pci != null ? R.postcodes[p.pci] : null;
    const names = pc ? suburbs.filter(s => s.pci === p.pci).map(s => s.name) : [];
    $('cardKicker').textContent = pc ? `Postcode ${String(pc).padStart(4, '0')}` : 'Outside NSW postcode records';
    $('cardTitle').textContent = names[0] ? names.slice(0, 2).join(' · ') + (names.length > 2 ? ` +${names.length - 2}` : '') : 'Chosen point';
    $('cardSub').textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · tap anywhere to move`;
    document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    if (state.tab === 'rent') $('pane').innerHTML = paneRent(p);
    else {
      // Advanced (Pro): the real evidence, previewed under a blur until Pro exists.
      const sections = [['Road', paneRoad], ['Sun', paneSun], ['Trees', paneTrees], ['Land records', paneLand], ['Planning', panePlan]];
      $('pane').innerHTML = `<div class="pro-wrap"><div class="pro-body${PRO ? '' : ' locked'}" aria-hidden="${!PRO}">${sections.map(([t, f]) => `<section><h3>${t}</h3>${f(p, ev)}</section>`).join('')}</div>${PRO ? '' : proLock('Road distance, sun hours, tree cover, land records and planning overlays for this exact spot.')}</div>`;
    }
    renderCompare();
  }
  // One tap: "this card looks wrong" → a pseudonymous feedback event (no text, no address). CVF escalates
  // when several arrive in a day, so a broken data source reaches an agent without anyone writing a report.
  const flag = $('flagWrong');
  if (flag) flag.addEventListener('click', () => {
    const p = state.point; if (!p || flag.dataset.done) return;
    window.SH && SH.track('feedback', { kind: 'wrong', cta: state.tab, ...(p.pci != null ? { postcode: String(R.postcodes[p.pci]).padStart(4, '0') } : {}) });
    flag.dataset.done = '1'; flag.textContent = 'Thanks — logged';
  });
  function proLock(what) {
    return `<div class="pro-lock" role="note"><b>SHOWHAUS Pro</b><p>${what}</p><span class="soon">Coming soon</span></div>`;
  }
  function rentChart(byM) {
    // History timeline: monthly median (line), middle half (band), leases lodged (bars), every month labelled.
    const W = 320, H = 150, L = 34, Rr = 8, T = 14, B = 34, M = byM.length, xs = k => L + (W - L - Rr) * (M === 1 ? .5 : k / (M - 1));
    const stats = byM.map(v => ({ n: v.length, med: C.quantile(v, .5), lo: C.quantile(v, .25), hi: C.quantile(v, .75) }));
    const vals = stats.flatMap(s => s.n ? [s.lo, s.hi] : []); if (!vals.length) return '';
    const min = Math.min(...vals), max = Math.max(...vals), ys = v => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
    const nMax = Math.max(...stats.map(s => s.n)), barH = 16;
    const band = stats.map((s, k) => s.n ? `${xs(k).toFixed(1)},${ys(s.hi).toFixed(1)}` : null).filter(Boolean).join(' ') + ' ' + stats.map((s, k) => s.n ? `${xs(k).toFixed(1)},${ys(s.lo).toFixed(1)}` : null).filter(Boolean).reverse().join(' ');
    const line = stats.map((s, k) => s.n ? `${xs(k).toFixed(1)},${ys(s.med).toFixed(1)}` : null).filter(Boolean).join(' ');
    const first = stats.find(s => s.n), last = [...stats].reverse().find(s => s.n);
    const change = first && last ? Math.round((last.med - first.med) / first.med * 100) : null;
    return `<figure class="timeline"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly median rent, ${fmtYm(R.months[0])} to ${fmtYm(R.months.at(-1))}">
      ${[min, (min + max) / 2, max].map(v => `<line x1="${L}" x2="${W - Rr}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}" class="grid"/><text x="${L - 4}" y="${(ys(v) + 3).toFixed(1)}" class="ax" text-anchor="end">$${Math.round(v)}</text>`).join('')}
      <polygon points="${band}" class="band"/>
      ${stats.map((s, k) => s.n ? `<rect x="${(xs(k) - 5).toFixed(1)}" y="${(H - B + 2 + barH - barH * s.n / nMax).toFixed(1)}" width="10" height="${(barH * s.n / nMax).toFixed(1)}" class="bar"><title>${fmtYm(R.months[k])}: ${s.n} leases</title></rect>` : '').join('')}
      <polyline points="${line}" class="med"/>
      ${stats.map((s, k) => s.n ? `<circle cx="${xs(k).toFixed(1)}" cy="${ys(s.med).toFixed(1)}" r="3" class="pt"><title>${fmtYm(R.months[k])}: median ${C.weekly(s.med)} · middle half ${C.weekly(s.lo)}–${C.weekly(s.hi)} · ${s.n} leases</title></circle>` : '').join('')}
      ${R.months.map((ym, k) => `<text x="${xs(k).toFixed(1)}" y="${H - 2}" class="ax" text-anchor="middle">${new Date(Date.UTC(Math.floor(ym / 100), ym % 100 - 1, 1)).toLocaleDateString('en-AU', { month: 'narrow', timeZone: 'UTC' })}</text>`).join('')}
    </svg><figcaption>${C.weekly(first.med)} → <b>${C.weekly(last.med)}</b>${change != null ? ` <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${change}%</span>` : ''} · line = median, band = middle half, bars = leases per month (${fmtYm(R.months[0])}–${fmtYm(R.months.at(-1))})</figcaption></figure>`;
  }
  function paneRent(p) {
    if (p.pci == null) return `<div class="fact"><b>—</b><span>${tag('unknown')} no rental bond records for this point's postcode</span></div>`;
    const f = { ...filters(false), pcSet: new Set([p.pci]) };
    const idx = C.filterRents(R, f), v = idx.map(i => R.w[i]).sort((a, b) => a - b);
    const all = C.filterRents(R, { pcSet: new Set([p.pci]) });
    const byBed = BEDS.map(([b, l]) => { const x = all.filter(i => (R.b[i] >= 4 ? 4 : R.b[i]) === b).map(i => R.w[i]).sort((a, c) => a - c); return [l, x.length, C.quantile(x, .5)]; }).filter(r => r[1]);
    const byM = R.months.map((_, m) => idx.filter(i => R.m[i] === m).map(i => R.w[i]).sort((a, b) => a - b));
    const spark = rentChart(byM);
    const filt = state.beds.size || state.types.size || state.maxRent;
    return `<div class="fact"><b>${C.weekly(C.quantile(v, .5))}</b><span>median new lease${filt ? ', your filters' : ''} · ${v.length.toLocaleString('en-AU')} leases ${tag('counted')}</span></div>
      <p class="how">Middle half paid ${C.weekly(C.quantile(v, .25))} – ${C.weekly(C.quantile(v, .75))}</p>
      <ul class="salelist">${byBed.map(([l, n, m]) => `<li><span>${l} · ${n.toLocaleString('en-AU')}</span><span>${C.weekly(m)}</span></li>`).join('')}</ul>${spark}
      <p class="how">Every rental bond lodged with NSW Fair Trading for postcode ${String(R.postcodes[p.pci]).padStart(4, '0')} (whole postcode, not this street). CC BY 4.0.</p>`;
  }
  function panePlan(p, ev) {
    const pl = ev.plan; if (!pl || pl.s === 'load') return `<p class="note">Asking the NSW Planning Portal…</p>`;
    const row = (label, r, fmt, none) => !r.ok ? `<li><span>${label}</span><span>${tag('unknown')}</span></li>` : `<li><span>${label}</span><span>${r.rows.length ? esc(fmt(r.rows[0])) : none}</span></li>`;
    return `<ul class="salelist plan">
      ${row('Zoning', pl.zoning, a => `${a.SYM_CODE} ${a.LAY_CLASS}`, 'no LEP zone mapped')}
      ${row('Bushfire prone land', pl.bushfire, a => a.d_Category || `Category ${a.Category}`, 'not mapped as prone')}
      ${row('Flood planning area', pl.flood, a => a.LAY_CLASS || 'inside', 'not in a published map*')}
      ${row('Western Sydney Airport noise', pl.anec, a => `ANEC ${a.ANEF_CODE}`, 'outside the ANEC contours')}
      <li><span>Sydney Airport noise</span><span>${tag('unknown')}</span></li></ul>
      <p class="note">*Many councils' flood maps aren't in the state layer yet, so "not in a published map" is not "won't flood". Sydney Airport ANEF contours aren't connected yet — unknown, never quiet.</p>
      <p class="how">NSW Planning Portal spatial services, fetched ${pl.at.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}. Check a planning certificate (s10.7) before you sign.</p>`;
  }
  function paneRoad(p, ev) {
    const r = ev.road; if (!r || r.s === 'load') return `<p class="note">Reading mapped roads…</p>`;
    if (r.s !== 'ok') return `<div class="fact"><b>—</b><span>${tag('unknown')} ${esc(r.why || '')}</span></div>`;
    const a = r.any, m = r.major;
    return `<div class="fact"><b>${Math.round(a.distance)} m</b><span>to the nearest mapped road (${esc(a.cls)}${a.name ? ' · ' + esc(a.name) : ''}) ${tag('counted')}</span></div>
      <div class="fact"><b>${m ? Math.round(m.distance) + ' m' : '> view'}</b><span>to the nearest primary road or bigger${m ? ' (' + esc(m.cls) + (m.name ? ' · ' + esc(m.name) : '') + ')' : ''} ${tag('counted')}</span></div>
      <p class="note">This is straight-line distance to road geometry — not a decibel level. Traffic volume, walls, and what's between you and the road change what you hear.</p>
      <p class="how">OpenStreetMap road centrelines via OpenFreeMap tiles, measured in your browser.</p>`;
  }
  function paneSun(p, ev) {
    const s = ev.sun; if (!s || s.s === 'load') return `<p class="note">Casting shadows from mapped buildings…</p>`;
    if (s.s !== 'ok') return `<div class="fact"><b>—</b><span>${tag('unknown')} ${esc(s.why || '')}</span></div>`;
    const h = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    const now = C.solarPosition(p.lat, p.lng, s.day, nowMinutes());
    if (!s.n) return `<div class="fact"><b>—</b><span>shade estimate ${tag('unknown')}</span></div>
      <p class="note">No building within 240 m has a mapped height (${s.total} footprints without heights), so we can't estimate shade here. Open sky today: ${h(s.today.daylightMinutes)} of daylight.</p>
      <p class="how">Sun now: ${now.elevation > 0 ? `${Math.round(now.elevation)}° up, from the ${compass(now.azimuth)}` : 'below the horizon'}. OpenStreetMap heights are missing in many Sydney streets.</p>`;
    return `<div class="fact"><b>${h(s.today.sunMinutes)}</b><span>direct sun at ground level today ${tag('est')}</span></div>
      <div class="fact"><b>${h(s.winter.sunMinutes)}</b><span>on 21 June (winter) ${tag('est')}</span></div>
      <p class="how">Daylight today ${h(s.today.daylightMinutes)} · uncertain (low sun) ${h(s.today.uncertainMinutes)} · ${s.n} of ${s.total} mapped buildings within 240 m have a height; ${s.today.blockingBuildings} cast shade here today. Sun now: ${now.elevation > 0 ? `${Math.round(now.elevation)}° up, from the ${compass(now.azimuth)}` : 'below the horizon'}.</p>
      <p class="note">Estimate: flat ground, OpenStreetMap building heights, no trees, no terrain. Not sunlight at a window or on a balcony.</p>`;
  }
  function paneTrees(p, ev) {
    const c = ev.canopy; if (!c || c.s === 'load') return `<p class="note">Asking the NSW canopy grid…</p>`;
    if (c.s === 'none') return `<div class="fact"><b>—</b><span>${tag('unknown')} outside the NSW 2024–25 canopy grid</span></div>`;
    if (c.s !== 'ok') return `<div class="fact"><b>—</b><span>${tag('unknown')} NSW canopy service: ${esc(c.why)}</span></div>`;
    return `<div class="fact"><b>${Math.round(c.canopy * 100)}%</b><span>tree canopy in this hexagon ${tag('live')}</span></div>
      <div class="fact"><b>${c.veg != null ? Math.round(c.veg * 100) + '%' : '—'}</b><span>all vegetation ${tag('live')}</span></div>
      <p class="how">NSW Government 2024–25 canopy H3 grid (~2.5 ha cells)${c.suburb ? ', ' + esc(c.suburb) : ''}. Fetched ${c.at.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}.</p>`;
  }
  function paneLand(p, ev) {
    const l = ev.land; if (!l || l.s === 'load') return `<p class="note">Checking NSW EPA notifications within 1 km…</p>`;
    if (l.s !== 'ok') return `<div class="fact"><b>—</b><span>${tag('unknown')} ${esc(l.why)}</span></div>`;
    const list = l.sites.slice(0, 5).map(s => `<li><span>${esc(titleCase(s.name || 'Unnamed'))}</span><span>${Math.round(s.d)} m</span></li>`).join('');
    return `<div class="fact"><b>${l.sites.length}</b><span>EPA-notified sites within 1 km ${tag('live')}</span></div>
      <ul class="salelist">${list}</ul>
      <p class="note">A notification marks a reported location, not a contaminated parcel or a health risk. No record here is not proof of clean land.</p>
      <p class="how">NSW EPA notified-sites service, CC BY 4.0.</p>`;
  }
  function placeLabel(p) { const n = suburbs.filter(s => s.kind === 'suburb' && s.pci === p.pci).map(s => s.name); return n[0] || (p.pci != null ? String(R.postcodes[p.pci]).padStart(4, '0') : 'this point'); }
  function rentOf(p) { if (p.pci == null) return null; const v = C.filterRents(R, { ...filters(false), pcSet: new Set([p.pci]) }).map(i => R.w[i]).sort((a, b) => a - b); return { med: C.quantile(v, .5), n: v.length }; }
  function renderCompare() {
    const pin = state.pin, p = state.point, btn = $('pinA');
    if (!pin) { btn.textContent = 'Compare with another place'; $('compare').textContent = ''; return; }
    btn.textContent = 'Stop comparing';
    if (!p || keyOf(pin) === keyOf(p)) { $('compare').innerHTML = `<b>${esc(placeLabel(pin))}</b> pinned — tap another place on the map`; return; }
    const a = rentOf(pin), b = rentOf(p);
    const diff = a?.med && b?.med ? Math.round((b.med - a.med) / a.med * 100) : null;
    $('compare').innerHTML = `<b>${esc(placeLabel(pin))}</b> ${C.weekly(a?.med)} · <b>${esc(placeLabel(p))}</b> ${C.weekly(b?.med)}${diff != null ? ` <span class="${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}${diff}%</span>` : ''}`;
  }

  // Avoid dense dots entirely in Explore; show one collision-managed count capsule
  // per visible cluster, preserving the full rental records for exact evidence.
  function syncPriceLabels() {
    if (!mapReady) return;
    const visibility = state.lens === 'map' && state.mode !== 'buy' ? 'visible' : 'none';
    if (map.getLayoutProperty('pc-nodes-n', 'visibility') !== visibility) map.setLayoutProperty('pc-nodes-n', 'visibility', visibility);
  }

  // ---------- map drawing for the pick ----------
  function circle(p, r, n = 64) { const c = []; for (let k = 0; k <= n; k++) { const t = k / n * 2 * Math.PI; c.push([p.lng + r * Math.sin(t) / (111320 * Math.cos(p.lat * Math.PI / 180)), p.lat + r * Math.cos(t) / 111320]); } return c; }
  function drawPick() {
    if (!mapReady || !state.point) return;
    const p = state.point, ev = evidence.get(keyOf(p)) || {}, f = [];
    f.push({ type: 'Feature', properties: { k: 'pin' }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
    if (PRO && ev.road?.s === 'ok') f.push({ type: 'Feature', properties: { k: 'road' }, geometry: { type: 'LineString', coordinates: [[p.lng, p.lat], ev.road.any.at] } });
    if (PRO && state.tab === 'adv') {
      f.push({ type: 'Feature', properties: { k: 'ring' }, geometry: { type: 'LineString', coordinates: circle(p, 1000) } });
      if (ev.land?.s === 'ok') for (const s of ev.land.sites) f.push({ type: 'Feature', properties: { k: 'land' }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } });
    }
    if (PRO && state.tab === 'adv') {
      const sp = C.solarPosition(p.lat, p.lng, sydneyToday(), nowMinutes());
      if (sp.elevation > 0) { const a = sp.azimuth * Math.PI / 180, r = 90; f.push({ type: 'Feature', properties: { k: 'sun' }, geometry: { type: 'LineString', coordinates: [[p.lng, p.lat], [p.lng + r * Math.sin(a) / (111320 * Math.cos(p.lat * Math.PI / 180)), p.lat + r * Math.cos(a) / 111320]] } }); }
    }
    map.getSource('pick').setData({ type: 'FeatureCollection', features: f });
  }

  // ---------- lenses ----------
  function setLens(l) {
    state.lens = l; body.dataset.lens = l;
    body.classList.toggle('pro-preview', !PRO && l !== 'map');
    $('proLens').hidden = PRO || l === 'map';
    if (!PRO && l !== 'map' && window.SH) SH.track('pro_interest', { lens: l });
    if (!PRO && l !== 'map') $('proLensWhat').textContent = { '3d': 'Rent terrain in 3D — every postcode raised by its median rent.', strata: 'Every layer at the chosen place, stacked: rent, roads, trees, sun path, land records.', time: 'Twelve months of leases at a glance, by bedrooms.' }[l];
    document.querySelectorAll('#lenses button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lens === l)));
    if (!mapReady) return;
    const is3d = l === '3d';
    map.setLayoutProperty('pc-3d', 'visibility', is3d ? 'visible' : 'none');
    map.setLayoutProperty('pc-fill', 'visibility', is3d ? 'none' : 'visible');
    map.easeTo(is3d ? { pitch: 58, bearing: -18, zoom: Math.min(map.getZoom(), 11.2), duration: 800 } : { pitch: 0, bearing: 0, duration: 700 });
    cue(); drawOverlay(); syncPriceLabels(); renderLegend();
  }
  function renderLegend() {
    const L = { map: 'Colour = median weekly rent of new leases matching your filters, by postcode', '3d': 'Height = median weekly rent, by postcode', strata: 'Layers at the chosen place, top to bottom', time: 'Rings = months (newest inside) · sectors = bedrooms · dot = leases' }[state.lens];
    const visualKey = '<div class="lease-scale">' + ['1', '2–9', '10–99', '100–999', '1k+'].map((label, i) => `<span><b class="lease-scale-meter">${[0, 1, 2, 3, 4].map(j => `<i class="${j <= i ? 'on' : ''}"></i>`).join('')}</b>${label}</span>`).join('') + '</div>';
    const detail = state.lens === 'map' ? (state.display === 'visual'
      ? '<div class="dotnote muted">Bars = orders of magnitude of new leases grouped at this zoom (not individual homes). Exact counts in Numbers mode and place details.</div>' + visualKey
      : '<div class="dotnote muted">Capsules ≈ new leases grouped at this zoom; tap to explore. Areas show postcode-level rents, not individual home locations. Exact counts appear in the place details.</div>') : '';
    $('legend').innerHTML = `<div>${L}</div><div class="ramp"></div><div class="row"><span>$350</span><span>$750</span><span>$1,300</span><span>$2,000+</span></div>${detail}`;
  }

  // ---------- overlay: strata & time (canvas over the map) ----------
  function drawOverlay() {
    const cv = $('overlay'), dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    if (!mapReady || !state.point || state.act !== 4 || (state.lens !== 'strata' && state.lens !== 'time')) return;
    const css = getComputedStyle(document.documentElement), ink = css.getPropertyValue('--ink').trim(), paper = css.getPropertyValue('--paper').trim();
    g.fillStyle = paper; g.globalAlpha = .82; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
    const c = map.project([state.point.lng, state.point.lat]);
    if (state.lens === 'time') drawTime(g, ink); else drawStrata(g, c, ink);
  }
  function drawTime(g, ink) {
    const p = state.point; if (p.pci == null) return;
    const cardW = innerWidth > 760 ? 400 : 0, cx = (innerWidth - cardW) / 2 + 40, cy = innerHeight / 2 + 24;
    const Rmax = Math.min((innerWidth - cardW) * .38, innerHeight * .36), M = R.months.length;
    const idx = C.filterRents(R, { ...filters(false), beds: null, pcSet: new Set([p.pci]) });
    const cells = new Map();
    for (const i of idx) { const b = R.b[i] >= 4 ? 4 : R.b[i] < 0 ? -1 : R.b[i]; if (b < 0) continue; const k = R.m[i] * 10 + b; (cells.get(k) || cells.set(k, []).get(k)).push(R.w[i]); }
    g.strokeStyle = ink; g.fillStyle = ink; g.font = '11px Inter, sans-serif'; g.textAlign = 'center';
    for (let m = 0; m < M; m++) { const r = Rmax * (M - m) / M; g.globalAlpha = .18; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke(); g.globalAlpha = .65; if (m % 3 === 0 || m === M - 1) g.fillText(fmtYm(R.months[m]), cx, cy - r - 4); }
    g.globalAlpha = 1;
    BEDS.forEach(([b, label], s) => {
      const a0 = -Math.PI / 2 + (s + .5) * 2 * Math.PI / BEDS.length;
      g.fillStyle = ink; g.font = '600 12px Inter, sans-serif'; g.fillText(label, cx + Math.cos(a0) * (Rmax + 22), cy + Math.sin(a0) * (Rmax + 22) + 4);
      for (let m = 0; m < M; m++) {
        const v = cells.get(m * 10 + b); if (!v) continue;
        const med = C.quantile(v.sort((x, y) => x - y), .5), r = Rmax * (M - m - .5) / M;
        const k = med < 550 ? 0 : med < 750 ? 1 : med < 950 ? 2 : med < 1300 ? 3 : med < 2000 ? 4 : 5;
        g.fillStyle = RAMP[k]; g.strokeStyle = ink; g.globalAlpha = .9;
        g.beginPath(); g.arc(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, Math.min(14, 2 + Math.sqrt(v.length) * 1.2), 0, 7); g.fill(); g.globalAlpha = .4; g.stroke(); g.globalAlpha = 1;
      }
    });
    g.textAlign = 'left'; g.fillStyle = ink; g.font = '600 13px Inter Tight';
    g.fillText(`${idx.length.toLocaleString('en-AU')} leases in ${String(R.postcodes[p.pci]).padStart(4, '0')} · colour = median weekly rent`, Math.max(110, cx - Rmax), Math.max(96, cy - Rmax - 40));
  }
  function drawStrata(g, c, ink) {
    const p = state.point, ev = evidence.get(keyOf(p)) || {};
    const RAD = 300, kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 111320;
    const pcf = p.pci != null ? pcFC.features.find(f => f.properties.pci === p.pci) : null;
    const layers = [
      { name: 'Rent · postcode', val: pcf && pcf.properties.n ? `${C.weekly(pcf.properties.med)} median (counted)` : 'unknown', col: '#c4622d', scale: 2500, draw: (pt) => { if (!pcf) return; const polys = pcf.geometry.type === 'Polygon' ? [pcf.geometry.coordinates] : pcf.geometry.coordinates; g.lineWidth = 1.5; for (const poly of polys) { g.beginPath(); poly[0].forEach((q, k) => { const [x, y] = pt(q[0], q[1]); k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.globalAlpha = .25; g.fill(); g.globalAlpha = 1; g.stroke(); } } },
      { name: 'Road geometry', val: ev.road?.s === 'ok' ? `${Math.round(ev.road.any.distance)} m to ${ev.road.any.cls}` : 'unknown', col: '#2f4c7a', draw: (pt) => { if (ev.road?.s !== 'ok') return; for (const l of ev.road.local) { g.lineWidth = ROAD_RANK[l.cls] >= 4 ? 3 : 1.2; g.beginPath(); l.pts.forEach((q, k) => { const [x, y] = pt(q[0], q[1]); k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); } } },
      { name: 'Canopy', val: ev.canopy?.s === 'ok' ? `${Math.round(ev.canopy.canopy * 100)}% of hexagon (live)` : 'unknown', col: '#4f7d4a', draw: (pt, w, h) => { if (ev.canopy?.s !== 'ok') return; const n = Math.round(ev.canopy.canopy * 400); let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; for (let k = 0; k < n; k++) { g.beginPath(); g.arc(rnd() * w, rnd() * h, 1.6, 0, 7); g.fill(); } } },
      { name: 'Sun path · today', val: ev.sun?.s === 'ok' && ev.sun.n ? `${(ev.sun.today.sunMinutes / 60).toFixed(1)} h at ground (est.)` : 'shade unknown (no mapped heights)', col: '#e2a234', draw: (pt) => { const day = sydneyToday(); g.lineWidth = 2; g.beginPath(); let started = false; for (let m = 270; m <= 1260; m += 15) { const sp = C.solarPosition(p.lat, p.lng, day, m); if (sp.elevation <= 0) continue; const a = sp.azimuth * Math.PI / 180, r = RAD * (1 - sp.elevation / 90); const [x, y] = pt(p.lng + r * Math.sin(a) / kx, p.lat + r * Math.cos(a) / ky); started ? g.lineTo(x, y) : g.moveTo(x, y); started = true; } g.stroke(); } },
      { name: 'Land records · 1 km', val: ev.land?.s === 'ok' ? `${ev.land.sites.length} EPA notifications (live)` : 'unknown', col: '#8a4b2a', scale: 1000, draw: (pt) => { if (ev.land?.s !== 'ok') return; for (const st of ev.land.sites) { const [x, y] = pt(st.lng, st.lat); g.fillRect(x - 3, y - 3, 6, 6); } } },
    ];
    const cardW = innerWidth > 760 ? 400 : 0;
    const w = Math.min(340, (innerWidth - cardW) * .38), dy = Math.min(92, (innerHeight - 200) / layers.length), h = dy * 1.25;
    const top = Math.max(84, innerHeight / 2 - dy * layers.length / 2), x0 = Math.max(110, (innerWidth - cardW) / 2 - w / 2 - 80);
    layers.forEach((L, k) => {
      const y = top + k * dy, span = L.scale || RAD;
      g.save(); g.translate(x0, y); g.transform(1, 0, -0.6, 0.45, h * .6, 0);
      g.fillStyle = L.col + '22'; g.strokeStyle = L.col; g.lineWidth = 1.2; g.fillRect(0, 0, w, h); g.strokeRect(0, 0, w, h);
      g.beginPath(); g.rect(0, 0, w, h); g.clip();
      const pt = (lng, lat) => [w / 2 + (lng - p.lng) * kx / span * w / 2, h / 2 - (lat - p.lat) * ky / span * h / 2];
      g.fillStyle = L.col; g.strokeStyle = L.col; L.draw(pt, w, h);
      g.fillStyle = '#7d5fc7'; g.beginPath(); g.arc(w / 2, h / 2, 4, 0, 7); g.fill();
      g.restore();
      const cx = x0 + w / 2 + h * .3, cy = y + h * .225;
      if (k < layers.length - 1) { g.setLineDash([3, 4]); g.strokeStyle = ink; g.globalAlpha = .45; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy + dy); g.stroke(); g.setLineDash([]); g.globalAlpha = 1; }
      g.fillStyle = ink; g.font = '600 12px Inter, sans-serif'; g.fillText(L.name, x0 + w + h * .6 + 18, y + 14);
      g.font = '400 12px Inter, sans-serif'; g.fillText(L.val, x0 + w + h * .6 + 18, y + 30);
    });
  }

  // ---------- small helpers ----------
  let audio = null;
  function cue() { // one short tick on mode switches; silent if audio is blocked
    try { audio = audio || new AudioContext(); const o = audio.createOscillator(), v = audio.createGain(); o.frequency.value = 660; v.gain.value = .03; o.connect(v).connect(audio.destination); o.start(); v.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + .08); o.stop(audio.currentTime + .09); } catch { /* no audio */ }
  }
  function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 3200); }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleCase = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, m => m.toUpperCase());
  const fmtDate = d => `${String(d % 100).padStart(2, '0')}/${String(Math.floor(d / 100) % 100).padStart(2, '0')}/${Math.floor(d / 10000)}`;
  const compass = a => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8];
  function sydneyToday() { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const g = k => p.find(x => x.type === k).value; return `${g('year')}-${g('month')}-${g('day')}`; }
  function nowMinutes() { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()); return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value); }

  // ---------- events ----------
  $('where').addEventListener('input', onWhere);
  document.querySelectorAll('[data-display]').forEach(b => b.addEventListener('click', () => setDisplay(b.dataset.display)));
  $('nearbyList').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]');
    if (b) { const s = suburbs.find(v => v.i === Number(b.dataset.i)); if (s) choosePlace(s); }
  });
  $('where').addEventListener('keydown', e => {
    const q = C.classifyWhere($('where').value);
    if (e.key === 'Tab' && suggestion && !sugg.length) { e.preventDefault(); $('where').value = suggestion.name; onWhere(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!sugg.length) return;
      suggPick = (suggPick + (e.key === 'ArrowDown' ? 1 : sugg.length - 1)) % sugg.length;
      document.querySelectorAll('#suggest button').forEach((b, k) => b.setAttribute('aria-selected', String(k === suggPick)));
      state.place = sugg[suggPick]; applyFilter(); return;
    }
    if (e.key === 'Enter') {
      if (q.kind === 'price') { state.pendingBudget = q.value; $('where').value = ''; onWhere(); toast(`Kept ${q.value < 10000 ? C.weekly(q.value) : C.money(q.value)} for the budget step.`); return; }
      if (sugg[suggPick]) choosePlace(sugg[suggPick]);
    }
  });
  $('suggest').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) choosePlace(suburbs.find(s => s.i === Number(b.dataset.i))); });
  $('presets').addEventListener('click', e => {
    const x = e.target.closest('button[data-x]');
    if (x) { const st = store.get(); st.recent = (st.recent || []).filter(p => p.name !== x.dataset.x); store.set(st); renderPresets(true); return; }
    const b = e.target.closest('button.go'); if (b) { const s = byName(b.dataset.name, b.dataset.pc || null); if (s) choosePlace(s); }
  });
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('budget').addEventListener('input', setBudgetFromSlider);
  $('beds').addEventListener('click', e => { const b = e.target.closest('button[data-bed]'); if (!b) return; const v = Number(b.dataset.bed); state.beds.has(v) ? state.beds.delete(v) : state.beds.add(v); cue(); renderFacets(); applyFilter(); });
  $('types').addEventListener('click', e => { const b = e.target.closest('button[data-type]'); if (!b) return; const v = Number(b.dataset.type); state.types.has(v) ? state.types.delete(v) : state.types.add(v); cue(); renderFacets(); applyFilter(); });
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(Number(b.dataset.go))));
  document.querySelectorAll('.cuts button').forEach(b => b.addEventListener('click', () => go(Number(b.parentElement.dataset.cut))));
  $('wants').addEventListener('click', e => { const b = e.target.closest('button[data-want]'); if (b) toggleWant(b.dataset.want); });
  $('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; state.tab = b.dataset.tab; if (!PRO && b.dataset.tab === 'adv' && window.SH) SH.track('pro_interest', { lens: 'advanced' }); cue(); renderCard(); drawPick(); });
  addEventListener('sh:account', () => {
    const next = !!(window.SH && SH.pro);
    if (next === PRO) return;
    PRO = next; document.body.classList.toggle('pro', PRO);
    if (R) { setLens(state.lens); renderCard(); drawPick(); } // before the records load, the first render already reads PRO
    if (PRO) toast('Pro unlocked');
  });
  $('lenses').addEventListener('click', e => { const b = e.target.closest('button[data-lens]'); if (b) setLens(b.dataset.lens); });
  $('selection').addEventListener('click', e => { const b = e.target.closest('button[data-tok]'); if (b) removeToken(b.dataset.tok); });
  $('pinA').addEventListener('click', () => {
    if (state.pin) { state.pin = null; renderCompare(); return; }
    if (!state.point) return; state.pin = { ...state.point }; renderCompare(); toast('Pinned. Now tap another place on the map to compare rents.');
  });
  $('commuteWhere').addEventListener('input', () => { clearTimeout(commuteTimer); commuteTimer = setTimeout(geocodeCommute, 450); });
  $('commuteKm').addEventListener('input', () => { if (state.commute) { state.commute.km = Number($('commuteKm').value); $('commuteKmLabel').textContent = state.commute.km + ' km'; applyFilter(); renderWants(); } else geocodeCommute(); });
  $('proClose').addEventListener('click', () => setLens('map'));
  if ($('proWant')) $('proWant').addEventListener('click', () => { if (window.SH && (SH.signedIn || !SH.canSignIn)) { SH.track('pro_interest', { cta: 'count_me_in' }); toast('Counted. Thank you.'); setLens('map'); return; } setLens('map'); window.SH && SH.openSignIn('pro'); });
  addEventListener('resize', () => { map?.resize(); syncMapPadding(); drawOverlay(); });

  // ---------- boot ----------
  window.SHOWHAUS = { state, C, get amen() { return A; }, allowed, get pc() { return pcFC; }, get rents() { return R; }, get places() { return P; }, get map() { return map; }, evidence, currentIdx, keyOf };
  body.dataset.lens = 'map';
  $('budget').max = String(RENT_STEPS.length); $('budget').value = String(RENT_STEPS.length);
  document.querySelectorAll('#tabs button').forEach(b => { b.dataset.label = b.textContent.trim(); });
  setDisplay(state.display);
  loadData().then(() => { initMap(); go(1); renderPresets(true); onWhere(); setMode('rent'); })
    .catch(e => { initMap(); go(1); $('c1').textContent = '—'; $('whereHint').textContent = 'Records could not load: ' + e.message; });
})();
