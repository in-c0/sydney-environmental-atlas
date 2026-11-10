/* SHOWHAUS listing ↔ Site Walk viewer: which light state the walk opens on, and the messages between them.
   Pure functions shared by listing.js and the Node tests. No DOM, no network.
   The viewer (in-c0/spatial-world-engine services/viewer/splat.js) reads world.json "splats": one day, a few light states,
   each with t = fraction of the day from sunrise to sunset — the same 0..1 scale as the hero's sun dot. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShowhausWalkSun = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SUN_MESSAGE = 'showhaus:sun';
  const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** The usable states of a world.json "splats" block (id, label, t, local_time), sorted by t; [] when there are none. */
  function splatStates(splats) {
    if (!splats || !Array.isArray(splats.states)) return [];
    return splats.states
      .filter(s => s && ID.test(String(s.id || '')) && Number.isFinite(Number(s.t)) && Number(s.t) >= 0 && Number(s.t) <= 1)
      .map(s => ({ id: s.id, label: String(s.label || s.id).slice(0, 40), t: Number(s.t), local_time: /^\d\d:\d\d$/.test(s.local_time || '') ? s.local_time : null }))
      .sort((a, b) => a.t - b.t);
  }

  /** The state nearest the fraction of the day f (0 = sunrise, 1 = sunset); ties go to the earlier state. */
  function nearestState(states, f) {
    if (!states || !states.length) return null;
    const x = Number.isFinite(Number(f)) ? Number(f) : 0.5;
    let best = states[0];
    for (const s of states) if (Math.abs(s.t - x) < Math.abs(best.t - x) - 1e-9) best = s;
    return best;
  }

  function sameOrigin(u, href) {
    if (!u) return null;
    try { const x = new URL(u, href); return x.origin === new URL(href).origin ? x.href : null; } catch { return null; }
  }

  /** The viewer URL for a walk, or null. Gated exactly as before: a hosted world, or a same-origin ?viewer=&world= preview. */
  function walkHref(world, query, href, intent, sun) {
    const w = world || {}, q = query || new URLSearchParams();
    const viewer = sameOrigin(q.get('viewer') || '', href) || (w.hosted && w.viewer ? sameOrigin(w.viewer, href) : null);
    const worldUrl = sameOrigin(q.get('world') || '', href) || (w.hosted && w.url ? sameOrigin(w.url, href) : null);
    if (!viewer || !worldUrl) return null;
    const u = new URL(viewer);
    u.searchParams.set('static', worldUrl); u.searchParams.set('intent', intent); u.searchParams.set('noflash', '1');
    if (sun && ID.test(sun)) u.searchParams.set('sun', sun);
    return u.href;
  }

  /** A state id from the viewer frame's postMessage, or null: same origin, from that frame only, the agreed shape. */
  function readSunMessage(event, { origin, source }) {
    if (!event || event.origin !== origin || !source || event.source !== source) return null;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.type !== SUN_MESSAGE || typeof d.id !== 'string') return null;
    return ID.test(d.id) ? d.id : null;
  }

  const sunMessage = id => ({ type: SUN_MESSAGE, id: String(id) });

  function fmtDay(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
  }

  return { SUN_MESSAGE, splatStates, nearestState, walkHref, readSunMessage, sunMessage, fmtDay };
});
