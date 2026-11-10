/* SHOWHAUS listing page (/l/<slug>). Reads ./data/<slug>.json (scripts/showhaus_listings_build.py).
   Hero: the day from sunrise to sunset, one slot per season; every slot is labelled "generated" and nothing here is called a photo.
   Walk / Go inside: the Site Walk viewer (in-c0/spatial-world-engine) against the listing's pre-baked static world, once that
   world is published. Until then the buttons say so. For a local preview, ?viewer=<same-origin url>&world=<same-origin url>.
   A world with Gaussian splats (world.json "splats", one day of light in a few states) opens on the state nearest the hero's
   sun dot (?sun=<id>), and the page follows the viewer's state through postMessage (walk-sun.js). */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const slug = ((location.pathname.match(/\/l\/([a-z0-9-]{3,80})(?:\/)?$/) || [])[1] || qs.get('slug') || '').replace(/[^a-z0-9-]/g, '');
  const C = window.ShowhausCore, WS = window.ShowhausWalkSun;
  const track = (name, props = {}) => { try { window.SH && window.SH.track(name, { kind: 'listing:' + slug, ...props }); } catch { /* never breaks the page */ } };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Fixed days for the four seasons: solstices and equinoxes, Sydney time.
  const SEASONS = [
    { id: 'summer', label: 'Summer', day: '2026-12-21', short: '21 Dec' },
    { id: 'autumn', label: 'Autumn', day: '2027-03-20', short: '20 Mar' },
    { id: 'winter', label: 'Winter', day: '2027-06-21', short: '21 Jun' },
    { id: 'spring', label: 'Spring', day: '2026-09-23', short: '23 Sep' },
  ];
  // One small drawing per season: the sun's height at noon over a horizon line.
  const ICON = { summer: 4, autumn: 9, winter: 13, spring: 9 };
  const icon = id => `<svg viewBox="0 0 22 22" aria-hidden="true"><path class="h" d="M2 18h18"/><circle class="s" cx="11" cy="${ICON[id]}" r="3.6"/></svg>`;
  let L = null, season = null, sun = null, t0 = performance.now();
  // The walk's light: the splat states of the world (if any), the state the viewer is showing, and where the hero's dot is.
  let walkLight = null, walkSun = null, dotF = 0.5, pendingSun = null;

  function text(el, t) { el.textContent = t == null ? '' : String(t); }
  function fail(msg) { document.body.dataset.state = 'error'; text($('name'), msg); }

  // ---------- the day ----------
  function dayCurve(day) {
    const [lng, lat] = L.lnglat, pts = [];
    let rise = null, set = null;
    for (let m = 0; m <= 1440; m += 2) {
      const p = C.solarPosition(lat, lng, day, m);
      if (p.elevation > 0 && rise === null) rise = m;
      if (p.elevation > 0) set = m;
      pts.push([m, p.elevation, p.azimuth]);
    }
    const day_ = pts.filter(([m]) => m >= rise && m <= set);
    return { rise, set, pts: day_, peak: Math.max(...day_.map(p => p[1])) };
  }
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  const compass = a => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8];
  function drawArc() {
    const span = sun.set - sun.rise, x = m => (m - sun.rise) / span * 1000, y = e => 200 - Math.max(0, e) / 90 * 190;
    $('arcPath').setAttribute('d', sun.pts.map(([m, e], i) => `${i ? 'L' : 'M'}${x(m).toFixed(1)} ${y(e).toFixed(1)}`).join(' '));
  }
  // The dot runs sunrise → sunset over the hero's 10 s, in step with a real render; with a placeholder it keeps its own clock.
  function tick() {
    if (sun) {
      const v = $('heroVideo'), synced = slotOf(season)?.status === 'rendered' && v.duration > 0;
      // While the walk is open, the dot holds at the viewer's light state (same 0..1 sunrise-to-sunset scale).
      const held = walkSun && $('walkDlg').open;
      const f = held ? walkSun.t : synced ? v.currentTime / v.duration : reduced ? 0.5 : ((performance.now() - t0) / 10000) % 1;
      dotF = f;
      const m = sun.rise + f * (sun.set - sun.rise), p = C.solarPosition(L.lnglat[1], L.lnglat[0], SEASONS.find(s => s.id === season).day, m);
      const cx = f * 1000, cy = 200 - Math.max(0, p.elevation) / 90 * 190;
      $('arcSun').setAttribute('cx', cx.toFixed(1)); $('arcSun').setAttribute('cy', cy.toFixed(1));
      if (!tick.last || performance.now() - tick.last > 250) {
        tick.last = performance.now();
        text($('sunRead'), `${hhmm(m)} · sun ${Math.round(p.elevation)}° up in the ${compass(p.azimuth)} · sunrise ${hhmm(sun.rise)}, sunset ${hhmm(sun.set)} (computed)`);
      }
    }
    if (!reduced || !tick.once) { tick.once = true; requestAnimationFrame(tick); }
  }
  const slotOf = id => ((L.renders.hero || {}).seasons || []).find(s => s.id === id);
  function setSeason(id, { user = false } = {}) {
    season = id;
    const s = SEASONS.find(x => x.id === id), slot = slotOf(id) || { status: 'not rendered' }, hero = L.renders.hero || {};
    document.querySelectorAll('.season').forEach(b => b.setAttribute('aria-checked', String(b.dataset.season === id)));
    sun = dayCurve(s.day); drawArc(); t0 = performance.now();
    const media = slot.media || hero.media;
    const v = $('heroVideo');
    if (media && media.video && v.getAttribute('src') !== media.video) { v.src = media.video; v.poster = media.poster || ''; }
    if (media && media.video) v.play().catch(() => {});
    $('heroPoster').hidden = !!(media && media.video);
    if (!(media && media.video) && media && media.poster) { $('heroPoster').src = media.poster; }
    const rendered = slot.status === 'rendered';
    text($('heroStamp'), rendered ? 'generated' : 'generated · placeholder');
    text($('heroNote'), rendered ? `${s.label}, ${s.short}: rendered from sunrise to sunset.`
      : slot.status === 'placeholder' ? `Placeholder until the sunrise-to-sunset render exists. ${hero.what || ''}`.trim()
      : `${s.label} (${s.short}) is not rendered yet, so the video is still the placeholder. The sun path over it is computed for ${s.short}.`);
    if (user) track('cta', { cta: 'season', step: id });
  }
  function seasonButtons() {
    const box = $('seasons');
    box.innerHTML = SEASONS.map(s => `<button type="button" role="radio" class="season" data-season="${s.id}" aria-checked="false">${icon(s.id)}<span>${s.label}</span><small>${s.short}</small></button>`).join('');
    box.addEventListener('click', e => { const b = e.target.closest('[data-season]'); if (b) setSeason(b.dataset.season, { user: true }); });
    box.addEventListener('keydown', e => {
      if (!/^Arrow(Left|Right)$/.test(e.key)) return;
      const i = SEASONS.findIndex(s => s.id === season), n = (i + (e.key === 'ArrowRight' ? 1 : 3)) % 4;
      setSeason(SEASONS[n].id, { user: true }); box.querySelector(`[data-season="${SEASONS[n].id}"]`).focus();
    });
  }

  // ---------- the walk ----------
  function walkTarget(intent, sunId) { return WS.walkHref(L.world, qs, location.href, intent, sunId); }
  // The splat states: from the listing model when the build copies them, otherwise from the world file itself (same origin).
  async function loadWalkLight() {
    const w = L.world || {};
    let splats = w.splats || null;
    if (!splats) {
      const u = new URL(walkTarget('walk')).searchParams.get('static');
      try { const r = await fetch(u); if (r.ok) splats = (await r.json()).splats || null; } catch { /* no light states: the viewer picks */ }
    }
    const states = WS.splatStates(splats);
    walkLight = states.length ? { day: splats.day, states } : null;
    const day = walkLight && WS.fmtDay(walkLight.day);
    text($('walkDay'), day ? `Light for one day, ${day}. The season buttons change only the video.` : '');
    $('walkDay').hidden = !day;
    if (pendingSun) showWalkSun(pendingSun);
  }
  const sunForWalk = () => (walkLight ? (WS.nearestState(walkLight.states, dotF) || {}).id || null : null);
  function showWalkSun(id) {
    if (!walkLight) { pendingSun = id; return; }
    const s = walkLight.states.find(x => x.id === id);
    if (!s) return;
    pendingSun = null;
    walkSun = s;
    text($('walkSun'), s.local_time ? `${s.label} · ${s.local_time}` : s.label); $('walkSun').hidden = false;
    const v = $('heroVideo');   // a real render shows the same time of day behind the dialog
    if (slotOf(season)?.status === 'rendered' && v.duration > 0) { v.pause(); v.currentTime = s.t * v.duration; }
  }
  addEventListener('message', e => {
    const id = WS.readSunMessage(e, { origin: location.origin, source: $('walkFrame').contentWindow });
    if (id) showWalkSun(id);
  });
  function setupWalk() {
    const w = L.world || {}, hasInside = (w.interiors || []).length > 0;
    const ready = !!walkTarget('walk');
    $('walk').disabled = !ready; $('inside').disabled = !ready || !hasInside;
    text($('worldNote'), ready ? `Shapes from open data${hasInside ? ' and the approved plans' : ''}. Surfaces are generated, so it will not look like a photo.`
      : w.status === 'baked' ? 'The walk is built and waiting: it opens here once it looks like the real place.'
      : 'There is no walk for this address yet.');
    for (const b of [$('walk'), $('inside')]) b.addEventListener('click', () => {
      const href = walkTarget(b.dataset.intent, sunForWalk()); if (!href) return;
      $('walkFrame').src = href; text($('walkTitle'), b.dataset.intent === 'inside' ? `Inside · ${L.name}` : L.name);
      $('walkDlg').showModal(); track('cta', { cta: 'walk', step: b.dataset.intent });
    });
    $('walkDlg').addEventListener('close', () => {
      $('walkFrame').src = 'about:blank';
      if (walkSun) {   // the hero carries on from the walk's time of day
        t0 = performance.now() - walkSun.t * 10000;
        const v = $('heroVideo'); if (slotOf(season)?.status === 'rendered' && v.duration > 0) v.play().catch(() => {});
      }
      walkSun = null; $('walkSun').hidden = true;
    });
    if (ready) loadWalkLight();
  }

  // ---------- records ----------
  function cards() {
    const box = $('cards'), tpl = $('cardTpl');
    for (const c of L.cards) {
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.dataset.card = c.id;
      text(el.querySelector('h2'), c.title);
      if (c.image) { const img = document.createElement('img'); img.src = c.image; img.alt = `${c.title}: SHOWHAUS model of the site`; img.loading = 'lazy'; el.insertBefore(img, el.querySelector('dl')); }
      const dl = el.querySelector('dl');
      for (const r of c.rows) {
        const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
        text(dt, r.label); text(dd, r.value); if (r.near_line) dd.className = 'near';
        row.append(dt, dd); dl.append(row);
      }
      if (!c.rows.length) { const row = document.createElement('div'); row.innerHTML = '<dt>Record</dt><dd>Not found for this address</dd>'; dl.append(row); }
      if (c.stated) { const p = el.querySelector('.stated'); p.hidden = false; p.append(`${c.stated.label}: “${c.stated.value}”. `); const a = document.createElement('a'); a.href = c.stated.source.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.stated.source.label; p.append(a); }
      const ul = el.querySelector('.notes');
      for (const n of c.notes || []) { const li = document.createElement('li'); text(li, n); ul.append(li); }
      const src = el.querySelector('.src');
      src.append('Source: ');
      if (c.source.url) { const a = document.createElement('a'); a.href = c.source.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.source.label; src.append(a); } else src.append(c.source.label);
      if (c.source.uncertainty_m) src.append(` · lines placed to about ±${c.source.uncertainty_m} m`);
      box.append(el);
    }
  }

  async function brand() {
    const by = (qs.get('by') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    if (!by) return;
    $('claimLink').hidden = true;   // a claimant's own share link does not invite others to claim
    try {
      const b = await (await fetch(`/api/claim/brand?c=${by}`)).json();
      if (b && b.company && b.slug === slug) { text($('by'), `Marketed by ${b.company}`); $('by').hidden = false; }
    } catch { /* no branding is the safe default */ }
  }

  async function boot() {
    if (!slug) return fail('No property given.');
    let r;
    try { r = await fetch(`./data/${slug}.json`); } catch (e) { return fail('This property could not load: ' + e.message); }
    if (!r.ok) return fail('This property is not on SHOWHAUS.');
    L = await r.json();
    document.title = `${L.name} · SHOWHAUS`;
    text($('name'), L.name); text($('addr'), L.address);
    $('claimLink').href = `./${slug}/claim${qs.get('utm_source') ? '?utm_source=' + encodeURIComponent(qs.get('utm_source')) : ''}`;
    text($('endorse'), (L.endorsement || 'Made by SHOWHAUS from public records. Not endorsed by the owner, the developer or any agency.').replace(/^None\.\s*/, ''));
    seasonButtons();
    const first = SEASONS.find(s => ['rendered', 'placeholder'].includes(slotOf(s.id)?.status)) || SEASONS[3];
    setSeason(first.id);
    setupWalk(); cards(); brand();
    document.body.dataset.state = 'ready';
    requestAnimationFrame(tick);
  }
  window.SHOWHAUS_LISTING = { get listing() { return L; }, get season() { return season; }, get sun() { return sun; }, walkTarget,
    get walkLight() { return walkLight; }, get walkSun() { return walkSun; }, dayFraction: () => dotF, sunForWalk };
  boot();
})();
