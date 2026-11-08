/* SHOWHAUS Studio — the walkthrough page. Data: ./data/<slug>.json (built by scripts/showhaus_studio_build.py). */
(() => {
  const C = window.StudioCore, S = window.ShowhausCore, SG = window.AtlasShadowGeometry;
  const qs = new URLSearchParams(location.search);
  const slug = (qs.get('p') || 'arncliffe-central').replace(/[^a-z0-9-]/g, '');
  const EMBED = qs.get('embed') === '1', KIT = qs.get('kit') === '1';
  const SRC = (qs.get('src') || (EMBED ? 'embed' : document.referrer ? 'ref' : 'direct')).slice(0, 60);
  const $ = id => document.getElementById(id);
  if (EMBED) document.body.classList.add('embed');
  if (KIT) document.body.classList.add('kit');
  if (qs.get('clean') === '1') document.body.classList.add('clean');

  // ---------- events: no cookies, no IP, no personal data ----------
  const track = (e, extra = {}) => {
    if (KIT) return;
    try {
      // Both beacon contracts on this Worker: studio fields (e, p, src, b, l) and the ops contract (name, path, props).
      const body = { e, name: e, p: slug, src: SRC, embed: EMBED ? 1 : 0, ...extra, path: location.pathname, props: { kind: 'studio:' + slug, cta: e, utm_source: SRC } };
      navigator.sendBeacon?.('/api/e', new Blob([JSON.stringify(body)], { type: 'application/json' }));
    } catch { /* best effort */ }
  };

  // ---------- day handling (Sydney local) ----------
  const sydToday = () => qs.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
  const year = sydToday().slice(0, 4);
  const dayFor = k => k === 'today' ? sydToday() : `${year}-${k}`;
  const dayLabel = k => k === 'today' ? 'today' : k === '06-21' ? '21 June (winter solstice)' : '21 December (summer solstice)';

  const state = { dayKey: 'today', clock: Number(qs.get('t')) || 720, tower: (qs.get('b') || '').toUpperCase(), level: qs.get('l') != null ? Number(qs.get('l')) : null, tab: 'sun', playing: !KIT, t0: 0, tPlay: 0, eye: null };
  let data, ctx, map, floors, keyframes = [], loopLen = 30, sunCache = new Map(), readyResolve, mapReady = false;
  window.studio = { ready: new Promise(r => { readyResolve = r; }), _resolve: () => readyResolve(), seek: t => seek(t), state, loopLen: () => loopLen,
    sunRows: (b, d) => sunRows(b, d), get data() { return data; }, keyframes: () => keyframes, pause: () => pause(), lookFrom: (b, l, a) => lookFrom(b, l, a, false), setDay: k => setDay(k, false), setClock: m => { state.clock = m; applySun(); }, sun: () => ({ rise: state.rise, set: state.set }) };

  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function boot() {
    const res = await fetch(`./data/${slug}.json`);
    if (!res.ok) { $('pname').textContent = 'Project not found'; $('plabel').textContent = `No walkthrough recorded for “${slug}”.`; document.body.dataset.state = 'error'; return; }
    data = await res.json();
    ctx = C.context(data);
    floors = C.floorFeatures(data);
    if (!data.towers.some(t => t.id === state.tower)) state.tower = data.towers.reduce((a, b) => (b.levels > a.levels ? b : a)).id;
    const tw = data.towers.find(t => t.id === state.tower);
    if (state.level == null || state.level < 0 || state.level >= tw.levels) state.level = tw.levels - 1;
    $('pname').textContent = data.project.name;
    $('plabel').textContent = 'massing model from public planning documents · sun position: NOAA · surrounding buildings: OpenStreetMap';
    document.title = `${data.project.name} · SHOWHAUS Studio`;
    $('pilotLink').href = `./pilot.html?src=${encodeURIComponent(SRC)}`;
    $('made').href = `https://showhaus.app/studio/?p=${slug}&src=made-with`;
    renderTowers(); renderSources(); setDay('today', false);
    initMap();
    track('view');
  }

  // ---------- map ----------
  function initMap() {
    const c = [ctx.lng, ctx.lat];
    map = new maplibregl.Map({
      container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: c, zoom: 16, pitch: 55, bearing: -35,
      maxPitch: 85, attributionControl: { compact: true }, preserveDrawingBuffer: KIT, fadeDuration: KIT ? 0 : 300, canvasContextAttributes: { antialias: true }
    });
    window.studio.map = map;
    map.on('load', () => {
      for (const l of map.getStyle().layers) if (/shield/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
      const dark = matchMedia('(prefers-color-scheme: dark)').matches && !KIT;
      map.addSource('site', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [data.site.boundary] } } });
      map.addSource('mass', { type: 'geojson', data: floors });
      map.addSource('targets', { type: 'geojson', data: { type: 'FeatureCollection', features: data.views.targets.map(tg => {
        const p = [tg.points.reduce((s, q) => s + q[0], 0) / tg.points.length, tg.points.reduce((s, q) => s + q[1], 0) / tg.points.length];
        return { type: 'Feature', properties: { label: `${tg.label} · ${(C.distanceM([ctx.lng, ctx.lat], p) / 1000).toFixed(1)} km` }, geometry: { type: 'Point', coordinates: p } }; }) } });
      map.addSource('shadow', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'shadow', type: 'fill', source: 'shadow', paint: { 'fill-color': '#1d2733', 'fill-opacity': .26 } });
      map.addLayer({ id: 'site-line', type: 'line', source: 'site', paint: { 'line-color': '#c4622d', 'line-width': 1.6, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'ctx3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13, paint: {
        'fill-extrusion-color': dark ? '#3a3f48' : '#d3d6da', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 4],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': .92 } });
      map.addLayer({ id: 'mass', type: 'fill-extrusion', source: 'mass', paint: {
        'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': .97, 'fill-extrusion-color': massColor() } });
      map.addLayer({ id: 'targets', type: 'symbol', source: 'targets', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 15, 'text-anchor': 'bottom', 'text-offset': [0, -.6], 'text-allow-overlap': true },
        paint: { 'text-color': '#2f4c7a', 'text-halo-color': '#efe6d4', 'text-halo-width': 1.6 } });
      map.addLayer({ id: 'targets-dot', type: 'circle', source: 'targets', paint: { 'circle-radius': 4, 'circle-color': '#2f4c7a', 'circle-stroke-color': '#efe6d4', 'circle-stroke-width': 1.5 } });
      map.on('click', 'mass', e => { const f = e.features?.[0]; if (!f) return; selectTower(f.properties.tower, Math.min(f.properties.level, data.towers.find(t => t.id === f.properties.tower).levels - 1)); });
      map.on('mouseenter', 'mass', () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', 'mass', () => map.getCanvas().style.cursor = '');
      mapReady = true;
      buildKeyframes();
      applySun();
      if (state.playing) play(true); else { document.body.dataset.state = 'paused'; seek(KIT ? 0 : 0); }
      window.studio._resolve();
    });
    map.on('error', e => { if (KIT) console.warn('map', e?.error?.message); });
    const stop = () => { if (state.playing) pause(); };
    map.getCanvas().addEventListener('pointerdown', stop);
    map.getCanvas().addEventListener('wheel', stop, { passive: true });
  }

  function massColor() {
    return ['case',
      ['all', ['==', ['get', 'tower'], state.tower], ['==', ['get', 'level'], state.level]], '#7d5fc7',
      ['==', ['get', 'kind'], 'roof'], '#c99a72',
      ['==', ['get', 'tower'], state.tower], '#dd8452',
      '#f1c9a0'];
  }
  const refreshMass = () => map?.getLayer('mass') && map.setPaintProperty('mass', 'fill-extrusion-color', massColor());

  // ---------- sun ----------
  function applySun() {
    const day = dayFor(state.dayKey), sun = S.solarPosition(ctx.lat, ctx.lng, day, state.clock);
    $('clockOut').textContent = `${hm(state.clock)}${sun.elevation <= 0 ? ' ☾' : ''}`;
    $('clock').value = state.clock;
    if (!map || !mapReady) return;
    const el = sun.elevation;
    const feats = [
      ...data.towers.map(t => ({ type: 'Feature', id: 'T' + t.id, properties: { render_height: t.height_m_est }, geometry: { type: 'Polygon', coordinates: [[...t.footprint, t.footprint[0]]] } })),
      ...data.context_buildings.features.map(b => ({ type: 'Feature', id: b.id, properties: { render_height: b.h }, geometry: { type: 'Polygon', coordinates: [b.r] } }))];
    const sh = el > 6 ? SG.buildShadowGeoJSON(feats, sun, { maxBuildings: 600, maxLengthMeters: 800 }) : { type: 'FeatureCollection', features: [] };
    map.getSource('shadow')?.setData(sh);
    const day01 = Math.max(0, Math.min(1, el / 35));
    map.setLight({ anchor: 'map', position: [1.3, sun.azimuth, Math.max(20, Math.min(80, 90 - el))], color: el < 8 ? '#fff0de' : '#ffffff', intensity: .3 + .2 * day01 });
    const dusk = el < 6;
    try { map.setSky({ 'sky-color': dusk ? '#f2b98a' : '#9cc6e8', 'horizon-color': dusk ? '#f6d6b0' : '#e8eef2', 'fog-color': '#efe6d4', 'sky-horizon-blend': .6, 'horizon-fog-blend': .4, 'fog-ground-blend': .85, 'atmosphere-blend': 0 }); } catch { /* older styles */ }
  }

  function setDay(k, user = true) {
    state.dayKey = k;
    document.querySelectorAll('#days button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.day === k)));
    const { rise, set } = C.sunriseSunset(ctx.lat, ctx.lng, dayFor(k), S.solarPosition);
    $('clock').min = Math.floor(rise / 5) * 5; $('clock').max = Math.ceil(set / 5) * 5;
    state.clock = Math.max(rise, Math.min(set, state.clock));
    state.rise = rise; state.set = set;
    applySun(); renderPanel();
    if (user) pause();
  }

  // ---------- floors & the lift ----------
  function renderTowers() {
    $('towers').innerHTML = data.towers.map(t => `<button type="button" data-t="${t.id}" aria-pressed="${t.id === state.tower}">${t.id}<span class="sr"> · ${t.levels} levels</span></button>`).join('');
    $('towers').querySelectorAll('button').forEach(b => b.onclick = () => { pause(); selectTower(b.dataset.t, null); });
  }
  function selectTower(id, level) {
    const t = data.towers.find(x => x.id === id); if (!t) return;
    const changed = id !== state.tower || level !== state.level;
    state.tower = id; state.level = level == null ? Math.min(state.level ?? t.levels - 1, t.levels - 1) : level;
    $('towers').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === id)));
    refreshMass(); renderPanel();
    if (changed && !state.auto) track('floor', { b: id, l: state.level });
  }

  function sunRows(towerId, dayKey) {
    const key = `${towerId}|${dayFor(dayKey)}`;
    if (sunCache.has(key)) return sunCache.get(key);
    const t = data.towers.find(x => x.id === towerId), rows = new Array(t.levels).fill(null);
    sunCache.set(key, rows);
    // fill progressively: selected level first, then the rest, without blocking the walkthrough
    const order = [state.level, ...Array.from({ length: t.levels }, (_, i) => t.levels - 1 - i).filter(i => i !== state.level)];
    let i = 0;
    const step = () => {
      const until = performance.now() + 12;
      while (i < order.length && performance.now() < until) {
        const lv = order[i++], r = {};
        for (const a of Object.keys(t.aspects)) r[a] = C.facadeSun(data, ctx, towerId, lv, a, dayFor(dayKey), S.solarPosition);
        rows[lv] = r;
      }
      if (state.tower === towerId && state.dayKey === dayKey) { renderLift(); if (rows[state.level]) renderSun(); }
      if (i < order.length) setTimeout(step, 0);
    };
    step();
    return rows;
  }

  const sunColor = (min, max) => {
    if (min == null) return 'transparent';
    const f = Math.max(0, Math.min(1, min / Math.max(60, max)));
    return `color-mix(in srgb, #e2a234 ${Math.round(12 + 88 * f)}%, var(--paper-2))`;
  };

  function renderLift() {
    const t = data.towers.find(x => x.id === state.tower), rows = sunRows(state.tower, state.dayKey);
    const asp = Object.keys(t.aspects);
    const maxSun = Math.max(60, ...rows.filter(Boolean).flatMap(r => asp.map(a => r[a]?.sunMinutes || 0)));
    $('lift').innerHTML = `<div class="cap">sun<br>${asp.join(' ')}</div>` + rows.map((r, lv) => `<button type="button" data-l="${lv}" aria-pressed="${lv === state.level}" title="Level ${lv}${r ? ' · ' + asp.map(a => `${a} ${C.hours(r[a].sunMinutes)} h`).join(', ') : ''}"><span>${lv === 0 ? 'G' : lv}</span><span class="cells">${asp.map(a => `<i style="background:${sunColor(r?.[a]?.sunMinutes, maxSun)}"></i>`).join('')}</span></button>`).join('');
    $('lift').querySelectorAll('button').forEach(b => b.onclick = () => { pause(); selectTower(state.tower, Number(b.dataset.l)); });
  }

  // ---------- panel ----------
  function renderPanel() {
    if (!data) return;
    const t = data.towers.find(x => x.id === state.tower), base = C.levelBase(t, state.level, data.floor_to_floor_m_est);
    $('selTitle').textContent = `${t.name} · ${state.level === 0 ? 'Ground' : 'Level ' + state.level}`;
    $('selSub').textContent = `floor ≈ ${base.toFixed(0)} m above ground (est.) · ${t.levels} levels · top RL ${t.max_rl_ahd_m} m AHD`;
    renderLift(); renderSun(); renderView(); renderNoise(); renderPlan();
  }

  function renderSun() {
    const t = data.towers.find(x => x.id === state.tower), r = sunRows(state.tower, state.dayKey)[state.level];
    const day = dayFor(state.dayKey);
    if (!r) { $('tab-sun').innerHTML = `<p class="note">Casting rays to the sun for ${esc(dayLabel(state.dayKey))}…</p>`; return; }
    const daylight = Object.values(r)[0].daylightMinutes;
    const rows = Object.entries(r).map(([a, v]) => `<div class="row"><span>${a}</span><span class="barw"><i style="width:${(100 * v.sunMinutes / daylight).toFixed(1)}%"></i><s style="left:${(100 * v.sunMinutes / daylight).toFixed(1)}%;width:${(100 * v.uncertainMinutes / daylight).toFixed(1)}%"></s></span><b>${C.hours(v.sunMinutes)} h</b></div>`).join('');
    const best = Object.entries(r).sort((a, b) => b[1].sunMinutes - a[1].sunMinutes)[0];
    $('tab-sun').innerHTML = `<div class="k">Direct sun per facade · ${esc(dayLabel(state.dayKey))} <span class="tag">est.</span></div>
      <div class="rows">${rows}</div>
      <p class="fact">Daylight ${hm(state.rise)}–${hm(state.set)} (${C.hours(daylight)} h). Sunniest side: <span class="v">${best[0]}</span>, ${best[1].first != null ? `${hm(best[1].first)}–${hm(best[1].last)}` : 'no direct sun'}.</p>
      <p class="note">Sun from NOAA solar position for ${esc(day)}. Counted when the sun is in front of the facade and the ray to it clears every mapped OpenStreetMap building and the other three buildings. Hatched = low sun or beyond the mapped ${data.context_buildings.radius_m} m radius (unknown, not counted). Flat ground, no trees, no balconies.</p>`;
  }

  function renderView() {
    const v = C.viewsAt(data, state.tower, state.level) || {};
    $('tab-view').innerHTML = `<div class="k">In line of sight from this level <span class="tag">est.</span></div>` +
      Object.entries(v).map(([a, list]) => `<div class="view"><span class="a">${a}</span><span>${list.length ? list.map(x => esc(x.label)).join(' · ') : '<span class="none">no listed landmark</span>'}</span><button class="look" type="button" data-a="${a}">Look ${a}</button></div>`).join('') +
      `<p class="note">Checked: ${data.views.targets.map(x => esc(x.label)).join(', ')}. Straight line from the window over terrain and every mapped building; trees, unmapped and future buildings are not in the model. “Look” puts the camera at this floor’s height.</p>`;
    $('tab-view').querySelectorAll('.look').forEach(b => b.onclick = () => { pause(); lookFrom(state.tower, state.level, b.dataset.a, true); });
  }

  function renderNoise() {
    const n = data.noise, road = data.road.find(r => r.tower === state.tower);
    $('tab-noise').innerHTML = `<div class="k">Aircraft</div><p class="fact">${esc(n.aircraft.text)}. <span class="tag">planning document</span></p>
      <p class="note">${esc(n.aircraft.source)}. ${esc(n.aircraft.geometry)}</p>
      <div class="k">Roads &amp; rail · LAeq dB(A) day / night</div>
      ${n.traffic.concat([n.rail]).map(x => `<p class="fact">${esc(x.where)}: <span class="v">${x.day_laeq15h} / ${x.night_laeq9h}</span></p>`).join('')}
      <p class="note">${esc(n.traffic_source)}</p>
      <div class="k">Nearest main road to ${esc(data.towers.find(t => t.id === state.tower).name)}</div>
      <p class="fact">${road ? `<span class="v">${road.distance_m} m</span> to ${esc(road.name || road.class)} (footprint edge to road centreline, OpenStreetMap)` : 'unknown'}</p>`;
  }

  function renderPlan() {
    const t = data.towers.find(x => x.id === state.tower), pc = data.planning_controls.find(p => p.tower === state.tower);
    const f = (k, fmt) => { const q = pc?.[k]; if (!q || q.status !== 'ok') return 'unavailable'; if (!q.features.length) return 'none mapped'; return q.features.map(fmt).join('; '); };
    $('tab-plan').innerHTML = `<div class="k">Approved (${esc(data.project.application.split(' (')[0])})</div>
      <p class="fact">Max height <span class="v">RL ${t.max_rl_ahd_m} m AHD</span> ≈ ${t.height_m_est} m above ground <span class="tag">est.</span> · ${t.levels} levels</p>
      <p class="fact">Footprint ≈ <span class="v">${t.area_m2} m²</span> typical floor (traced) · ${esc(data.project.description.split(' (')[0])}</p>
      <div class="k">Planning controls at this building (NSW Planning)</div>
      <p class="fact">Zone: <span class="v">${f('zoning', x => `${x.SYM_CODE} ${x.LAY_CLASS}`)}</span></p>
      <p class="fact">LEP height of buildings: <span class="v">${f('height_of_buildings', x => `${x.MAX_B_H} ${x.UNITS}`)}</span> · FSR <span class="v">${f('fsr', x => `${x.FSR}:1`)}</span></p>
      <p class="fact">Heritage item: <span class="v">${f('heritage', x => x.H_NAME || x.LAY_CLASS)}</span></p>
      <p class="note">${esc(pc?.zoning?.features?.[0]?.EPI_NAME || '')}, map currency ${esc(pc?.zoning?.features?.[0]?.CURRENCY_DATE || '—')}. A state significant development consent can differ from the LEP controls.</p>`;
  }

  function renderSources() {
    const d = data, docs = d.documents;
    const t = d.towers.map(t => `<li><b>${esc(t.name)}</b>: ${esc(t.sources.footprint)}. ${esc(t.sources.levels)}. ${esc(t.sources.max_rl)}. ${esc(t.sources.ground_rl)}. Floor-to-floor ${t.floor_to_floor_m_est} m (est.).</li>`).join('');
    $('srcBody').innerHTML = `<p class="fact"><b>${esc(d.project.name)}</b> — ${esc(d.project.address)}. ${esc(d.project.application)}.</p>
      <p class="fact"><b>What this is:</b> a massing model from public planning documents placed among real surrounding buildings (OpenStreetMap), lit by the real sun position (NOAA). It is not photoreal, not an architect’s model and not marketing material of the developer. ${esc(d.project.endorsement)}</p>
      <h3>Documents (NSW Planning Portal)</h3><ul>
        <li><a href="${docs.project_page}" target="_blank" rel="noopener">Project page SSD-11429726</a></li>
        <li><a href="${docs.consolidated_consent}" target="_blank" rel="noopener">Consolidated consent (MOD-10)</a> — maximum RLs, drawing list</li>
        <li><a href="${docs.assessment_report}" target="_blank" rel="noopener">Assessment report (2022)</a> — heights in m and RL</li>
        <li><a href="${docs.stamped_plans_part1}" target="_blank" rel="noopener">Stamped plans part 1</a> — Level 8–12 plan used for footprints</li>
        <li><a href="${docs.noise_assessment}" target="_blank" rel="noopener">Noise and vibration assessment (EIS App. P)</a></li></ul>
      <h3>Figures used</h3><ul>${t}</ul>
      <h3>Method</h3><ul><li>${esc(d.views.method)}</li>${d.notes.map(n => `<li>${esc(n)}</li>`).join('')}
        <li>Site boundary: ${esc(d.site.source)} (lot ${esc(d.site.lot)}, ${d.site.area_m2_cadastre} m²; assessment report: ${d.site.area_m2_assessment_report} m²).</li>
        <li>Terrain: ${esc(d.terrain.source)}.</li></ul>
      <h3>Licences</h3><ul>${d.sources.map(s => `<li>${esc(s.what)}: ${esc(s.who)} (${esc(s.licence)})</li>`).join('')}</ul>
      <p class="note">Built ${esc(d.generated)} by scripts/showhaus_studio_build.py. est. = modelled from mapped geometry, never measured by SHOWHAUS.</p>`;
  }

  // ---------- camera: eye at a floor ----------
  function eyeOptions(towerId, level, aspect, targetId) {
    const e = C.eyeCamera(data, towerId, level, aspect, targetId);
    const o = map.calculateCameraOptionsFromCameraLngLatAltRotation(new maplibregl.LngLat(e.lngLat[0], e.lngLat[1]), e.altitude, e.bearing, 84);
    return { center: [o.center.lng, o.center.lat], zoom: o.zoom, pitch: o.pitch, bearing: o.bearing };
  }
  function lookFrom(towerId, level, aspect, animate) {
    selectTower(towerId, level);
    const seen = C.viewsAt(data, towerId, level)?.[aspect] || [];
    const o = eyeOptions(towerId, level, aspect, seen[0]?.id);
    animate ? map.easeTo({ ...o, duration: 1800, essential: true }) : map.jumpTo(o);
    state.eye = { towerId, level, aspect };
  }

  // ---------- the walkthrough ----------
  function buildKeyframes() {
    const c = [ctx.lng, ctx.lat];
    const top = data.towers.reduce((a, b) => (b.levels > a.levels ? b : a));
    const { best: b0, second: s0 } = C.bestOutlook(data);
    const best = { t: b0.t, a: b0.a, ids: b0.ids }, second = s0 && s0.ids.length ? s0 : null;
    const label = id => data.views.targets.find(x => x.id === id)?.label;
    const lst = ids => ids.length ? ids.map(label).join(' and ') : 'no listed landmark';
    const r = state.rise, s = state.set, road = data.road.slice().sort((a, b) => a.distance_m - b.distance_m)[0];
    const n = data.noise.traffic[0];
    const lv = best.t.levels - 1;
    const eyeA = [best.t.id, lv, best.a, best.ids.find(i => i === 'cbd') || best.ids[0]];
    const eyeB = second ? [best.t.id, lv, second.a, second.ids.find(i => i === 'bay') || second.ids[0]] : null;
    const capA = `View from ${esc(best.t.name)}, level ${lv}, facing ${C.ASPECT_WORD[best.a]}: ${esc(lst(best.ids))} in line of sight <span class="tag">est.</span>`;
    const capB = second ? `Same floor, facing ${C.ASPECT_WORD[second.a]}: ${esc(lst(second.ids))} <span class="tag">est.</span>` : capA;
    const orbit = (zoom, pitch, bearing) => ({ center: c, zoom, pitch, bearing });
    // `cut: true` = the camera jumps to this keyframe (no flight through the buildings); `pan` = slow turn at the window.
    keyframes = [
      { t: 0, cam: orbit(16.05, 55, -35), clock: r + 25, tower: top.id, level: top.levels - 1,
        cap: `<b>${esc(data.project.name)}</b> · ${data.towers.length} buildings, ${Math.min(...data.towers.map(t => t.levels))}–${Math.max(...data.towers.map(t => t.levels))} levels — massing from the approved planning documents` },
      { t: 6, cam: orbit(16.75, 64, 35), clock: 9.5 * 60, tower: top.id, level: Math.round(top.levels / 2),
        cap: `Surrounding buildings from OpenStreetMap; shadows from the sun’s real position (NOAA) for ${esc(dayLabel(state.dayKey))}` },
      { t: 12, cam: orbit(17.0, 70, 125), clock: 13 * 60, tower: best.t.id, level: Math.round(best.t.levels * .7),
        cap: `Every level, every facade: hours of direct sun today, on 21 June and on 21 December <span class="tag">est.</span>` },
      { t: 15.9, cam: orbit(16.9, 72, 185), clock: 14.6 * 60, tower: best.t.id, level: Math.round(best.t.levels * .7), cap: '' },
      { t: 16, eye: eyeA, cut: true, clock: 14.7 * 60, tower: best.t.id, level: lv, cap: capA },
      { t: 20.4, eye: eyeA, pan: 10, clock: 15.4 * 60, tower: best.t.id, level: lv, cap: capA },
      ...(eyeB ? [{ t: 20.5, eye: eyeB, cut: true, clock: 15.5 * 60, tower: best.t.id, level: lv, cap: capB },
                  { t: 24.4, eye: eyeB, pan: -10, clock: 16.4 * 60, tower: best.t.id, level: lv, cap: capB }] : []),
      { t: 24.5, cam: orbit(16.2, 58, 200), cut: true, clock: 16.6 * 60, tower: top.id, level: top.levels - 1,
        cap: `${esc(road.name || 'Main road')} ${road.distance_m} m from the nearest building; measured ${n.day_laeq15h} dB(A) by day at the frontage (applicant’s 2020 survey)` },
      { t: loopLen, cam: orbit(16.05, 55, -35 + 360), clock: s - 25, tower: top.id, level: top.levels - 1, cap: '' }];
    for (const k of keyframes) if (k.eye) { k.cam = eyeOptions(...k.eye); if (k.pan) k.cam.bearing += k.pan; }
  }
  const ease = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const lerp = (a, b, f) => a + (b - a) * f;
  function camAt(t) {
    t = ((t % loopLen) + loopLen) % loopLen;
    let i = 0; while (i < keyframes.length - 2 && keyframes[i + 1].t <= t) i++;
    const a = keyframes[i], b = keyframes[i + 1], f = b.cut ? 0 : ease((t - a.t) / (b.t - a.t));
    let db = b.cam.bearing - a.cam.bearing; db = ((db + 540) % 360) - 180;
    return { a, b, f, cam: { center: [lerp(a.cam.center[0], b.cam.center[0], f), lerp(a.cam.center[1], b.cam.center[1], f)], zoom: lerp(a.cam.zoom, b.cam.zoom, f), pitch: lerp(a.cam.pitch, b.cam.pitch, f), bearing: a.cam.bearing + db * f }, clock: Math.round(lerp(a.clock, b.clock, (t - a.t) / (b.t - a.t))) };
  }
  let lastCap = null;
  function seek(t) {
    if (!keyframes.length) return;
    const k = camAt(t);
    map.jumpTo(k.cam);
    state.clock = Math.max(state.rise, Math.min(state.set, k.clock)); applySun();
    const key = k.f < .5 ? k.a : k.b;
    if (key.tower !== state.tower || key.level !== state.level) { state.auto = true; selectTower(key.tower, key.level); state.auto = false; }
    const cap = k.a.cap; if (cap !== lastCap) { $('caption').innerHTML = cap; $('caption').classList.toggle('on', !!cap); lastCap = cap; }
  }
  let raf = 0;
  function frameLoop(now) {
    if (!state.playing) return;
    seek((now - state.t0) / 1000);
    raf = requestAnimationFrame(frameLoop);
  }
  function play(auto = false) {
    if (!keyframes.length) return;
    state.playing = true; document.body.dataset.state = 'playing';
    $('playBtn').textContent = '❚❚'; $('playBtn').setAttribute('aria-label', 'Pause walkthrough');
    state.t0 = performance.now() - (state.tPlay || 0) * 1000;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frameLoop);
    track('play', { auto: auto ? 1 : 0 });
  }
  function pause() {
    if (!state.playing) return;
    state.playing = false; state.tPlay = (performance.now() - state.t0) / 1000;
    document.body.dataset.state = 'paused'; cancelAnimationFrame(raf);
    $('playBtn').textContent = '▶'; $('playBtn').setAttribute('aria-label', 'Play walkthrough');
    $('caption').classList.remove('on');
  }

  // ---------- controls ----------
  $('playBtn').onclick = () => state.playing ? pause() : play();
  $('playBig').onclick = () => play();
  document.querySelectorAll('#days button').forEach(b => b.onclick = () => setDay(b.dataset.day));
  $('clock').oninput = e => { pause(); state.clock = Number(e.target.value); applySun(); };
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.id === 'tab-' + state.tab));
  });
  document.querySelectorAll('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('detailsBtn').onclick = () => { pause(); document.body.classList.add('details'); };
  $('closeDetails').onclick = () => document.body.classList.remove('details');
  $('srcBtn').onclick = () => { pause(); $('srcDlg').showModal(); };
  $('embedBtn').onclick = () => {
    pause();
    $('embedCode').textContent = `<script src="https://showhaus.app/studio/embed.js" data-project="${slug}" async></` + `script>`;
    $('copied').textContent = ''; $('embedDlg').showModal();
  };
  $('copyEmbed').onclick = async () => {
    try { await navigator.clipboard.writeText($('embedCode').textContent); $('copied').textContent = 'Copied.'; } catch { $('copied').textContent = 'Select the code above and copy it.'; }
    track('embed_copy');
  };
  addEventListener('keydown', e => { if (e.key === ' ' && e.target === document.body) { e.preventDefault(); state.playing ? pause() : play(); } });

  boot().catch(err => { console.error(err); $('pname').textContent = 'Could not load the walkthrough'; });
})();
