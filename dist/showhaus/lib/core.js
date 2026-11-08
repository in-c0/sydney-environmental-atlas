/* SHOWHAUS core: pure functions shared by the page and the Node tests. No DOM, no network. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShowhausCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const rad = Math.PI / 180, deg = 180 / Math.PI;

  // ---------- text & search ----------
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\bst\b/g, 'saint').replace(/\bmt\b/g, 'mount').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  function editDistance(a, b, cap = 4) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > cap) return cap + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  // What did the visitor type in the "where" field? Classify before searching (failure list: wrong-step input).
  function classifyWhere(raw) {
    const s = String(raw || '').trim();
    if (!s) return { kind: 'empty' };
    if (/^\$?\s*\d+(\.\d+)?\s*(k|m|mil|million)\b/i.test(s) || /^\$\s*\d/.test(s)) return { kind: 'price', value: parsePrice(s) };
    if (/^\d{4}$/.test(s)) return { kind: 'postcode', value: s };
    if (norm(s).length < 3) return { kind: 'short' };
    return { kind: 'text', value: norm(s) };
  }

  function parsePrice(s) {
    const m = String(s).toLowerCase().replace(/[, $]/g, '').match(/^(\d+(?:\.\d+)?)(k|m|mil|million)?/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const mult = m[2] === 'k' ? 1e3 : m[2] ? 1e6 : 1;
    return Math.round(n * mult);
  }

  // suburbs: [{name, postcode, lat, lng, n}] → ranked matches. Exact/prefix first, then typo (edit distance) weighted by sales count.
  function searchSuburbs(suburbs, raw, limit = 6) {
    const q = classifyWhere(raw);
    if (q.kind === 'postcode') return { query: q, scope: 'postcode', matches: suburbs.filter(s => s.postcode === q.value).sort((a, b) => b.n - a.n).slice(0, limit) };
    if (q.kind !== 'text') return { query: q, scope: 'none', matches: [] };
    const exact = [], prefix = [], contains = [];
    for (const s of suburbs) {
      const k = s.key || (s.key = norm(s.name));
      if (k === q.value) exact.push(s);
      else if (k.startsWith(q.value)) prefix.push(s);
      else if (k.includes(q.value)) contains.push(s);
    }
    const byCount = (a, b) => b.n - a.n;
    let matches = [...exact, ...prefix.sort(byCount), ...contains.sort(byCount)];
    let scope = exact.length ? 'exact' : matches.length ? 'close' : 'none';
    let suggestion = null;
    if (!matches.length && q.value.length >= 4) {
      let best = null;
      for (const s of suburbs) {
        const d = editDistance(q.value, s.key, 3);
        if (d <= 3) {
          const score = d - Math.log10(1 + s.n) * 0.25;
          if (!best || score < best.score) best = { s, score, d };
        }
      }
      if (best) suggestion = best.s;
    }
    return { query: q, scope, matches: matches.slice(0, limit), suggestion };
  }

  // ---------- sales ----------
  // sales: column arrays {lat,lng,price,date(yyyymmdd),area,sub,kind}. Returns indices that pass.
  function filterSales(sales, { suburbIdx = null, maxPrice = null, minDate = null } = {}) {
    const out = [];
    for (let i = 0; i < sales.price.length; i++) {
      if (suburbIdx != null && sales.sub[i] !== suburbIdx) continue;
      if (maxPrice != null && sales.price[i] > maxPrice) continue;
      if (minDate != null && sales.date[i] < minDate) continue;
      out.push(i);
    }
    return out;
  }
  function median(values) {
    if (!values.length) return null;
    const v = values.slice().sort((a, b) => a - b), m = v.length >> 1;
    return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
  }
  function monthsAgo(yyyymmdd, now = new Date()) {
    const y = Math.floor(yyyymmdd / 10000), m = Math.floor(yyyymmdd / 100) % 100;
    return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
  }
  function minusMonths(now, months) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }
  const money = v => v == null ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M` : `$${Math.round(v / 1e3)}k`;

  // ---------- rents (NSW rental bond lodgements, columnar) ----------
  // r: {pc[],m[],t[],b[],w[]}. Filters are exact; beds/types are Sets of codes (null = any).
  function filterRents(r, { pcSet = null, maxRent = null, beds = null, types = null, excludePc = null } = {}) {
    const out = [];
    for (let i = 0; i < r.w.length; i++) {
      if (pcSet && !pcSet.has(r.pc[i])) continue;
      if (excludePc && excludePc.has(r.pc[i])) continue;
      if (maxRent != null && r.w[i] > maxRent) continue;
      if (beds && !beds.has(r.b[i] >= 4 ? 4 : r.b[i])) continue;
      if (types && !types.has(r.t[i])) continue;
      out.push(i);
    }
    return out;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
  }
  const weekly = v => v == null ? '—' : '$' + Math.round(v).toLocaleString('en-AU') + '/wk';

  // ---------- geometry ----------
  function metres(a, b) {
    const n = (b.lat - a.lat) * 111320, e = (b.lng - a.lng) * 111320 * Math.cos(a.lat * rad);
    return Math.hypot(n, e);
  }
  // Nearest distance from a point to polylines given as [[lng,lat],...] (GeoJSON order). Returns {distance, at:[lng,lat]} or null.
  function nearestOnLines(point, lines) {
    const cx = 111320 * Math.cos(point.lat * rad), cy = 111320;
    let best = null;
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const ax = (a[0] - point.lng) * cx, ay = (a[1] - point.lat) * cy, bx = (b[0] - point.lng) * cx, by = (b[1] - point.lat) * cy;
        const vx = bx - ax, vy = by - ay;
        const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / (vx * vx + vy * vy || 1)));
        const px = ax + t * vx, py = ay + t * vy, d = Math.hypot(px, py);
        if (!best || d < best.distance) best = { distance: d, at: [point.lng + px / cx, point.lat + py / cy] };
      }
    }
    return best;
  }
  function pointInGeometry(lng, lat, g) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    return polys.some(p => pointInRing(lng, lat, p[0]) && !p.slice(1).some(h => pointInRing(lng, lat, h)));
  }
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------- sun (NOAA, same equations as the atlas) ----------
  function sydneyOffset(ymd) {
    try {
      const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', timeZoneName: 'shortOffset' }).formatToParts(new Date(ymd + 'T12:00:00Z'));
      const zone = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+10';
      const o = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(zone);
      return o ? Number(o[1]) + Math.sign(Number(o[1])) * Number(o[2] || 0) / 60 : 10;
    } catch { return 10; }
  }
  function solarPosition(lat, lng, day, localMinutes) {
    const [y, m, d] = day.split('-').map(Number), offset = sydneyOffset(day);
    const instant = new Date(Date.UTC(y, m - 1, d, 0, localMinutes) - offset * 3600000);
    const t = (instant.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
    const L = (280.46646 + t * (36000.76983 + .0003032 * t)) % 360;
    const M = 357.52911 + t * (35999.05029 - .0001537 * t);
    const e = .016708634 - t * (.000042037 + .0000001267 * t);
    const c = (1.914602 - t * (.004817 + .000014 * t)) * Math.sin(M * rad) + (.019993 - .000101 * t) * Math.sin(2 * M * rad) + .000289 * Math.sin(3 * M * rad);
    const omega = 125.04 - 1934.136 * t;
    const lambda = L + c - .00569 - .00478 * Math.sin(omega * rad);
    const eps = 23 + (26 + (21.448 - t * (46.815 + t * (.00059 - t * .001813))) / 60) / 60 + .00256 * Math.cos(omega * rad);
    const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
    const yy = Math.tan(eps * rad / 2) ** 2;
    const eqt = 4 * deg * (yy * Math.sin(2 * L * rad) - 2 * e * Math.sin(M * rad) + 4 * e * yy * Math.sin(M * rad) * Math.cos(2 * L * rad) - .5 * yy * yy * Math.sin(4 * L * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
    const tst = ((localMinutes + eqt + 4 * lng - 60 * offset) % 1440 + 1440) % 1440;
    const ha = (tst / 4 - 180) * rad, phi = lat * rad;
    const elevation = deg * Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha));
    const azimuth = (deg * Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + 180 + 360) % 360;
    return { azimuth, elevation };
  }
  // Minutes between sunrise and sunset (open sky, level horizon). Not sunlight at a window.
  function daylightMinutes(lat, lng, day, step = 5) {
    let n = 0;
    for (let mnt = 0; mnt < 1440; mnt += step) if (solarPosition(lat, lng, day, mnt).elevation > 0) n += step;
    return n;
  }
  // Estimated minutes the ground point is in direct sun, given a shadow caster (feature, sun) → polygon|null.
  // Buildings: GeoJSON features with render_height. Flat ground, mapped buildings only (est., labelled in UI).
  function sunMinutesAtPoint(point, buildings, day, castBuilding, { step = 10, minElevation = 6 } = {}) {
    let sun = 0, open = 0, uncertain = 0, blockedBy = new Set();
    const tallest = buildings.reduce((m, b) => Math.max(m, Number(b?.properties?.render_height) || 0), 0);
    for (let mnt = 270; mnt <= 1260; mnt += step) {
      const p = solarPosition(point.lat, point.lng, day, mnt);
      if (p.elevation <= 0) continue;
      open += step;
      // Low sun, or shadows longer than the 220 m cap: obstruction unknown → counted as uncertain, never as sun.
      if (p.elevation <= minElevation || tallest / Math.tan(p.elevation * rad) > 220) { uncertain += step; continue; }
      let shaded = false;
      for (let i = 0; i < buildings.length && !shaded; i++) {
        const poly = castBuilding(buildings[i], p, { maxLengthMeters: 220 });
        if (!poly) continue;
        const rings = poly.geometry.type === 'MultiPolygon' ? poly.geometry.coordinates.map(c => c[0]) : [poly.geometry.coordinates[0]];
        if (rings.some(r => pointInRing(point.lng, point.lat, r))) { shaded = true; blockedBy.add(i); }
      }
      if (!shaded) sun += step;
    }
    return { sunMinutes: sun, daylightMinutes: open, uncertainMinutes: uncertain, blockingBuildings: blockedBy.size };
  }

  // ---------- selection line ----------
  function selectionLine(state) {
    const t = [];
    if (state.place) t.push({ key: 'place', text: state.place.name + (state.place.postcode ? ' ' + state.place.postcode : '') });
    if (state.mode) t.push({ key: 'mode', text: state.mode === 'buy' ? 'buying' : state.mode === 'rent' ? 'renting' : 'just looking' });
    if (state.maxPrice) t.push({ key: 'maxPrice', text: 'up to ' + money(state.maxPrice) });
    if (state.maxRent) t.push({ key: 'maxRent', text: 'up to ' + weekly(state.maxRent) });
    for (const b of state.beds || []) t.push({ key: 'beds:' + b, text: b === 0 ? 'studio' : b >= 4 ? '4+ bed' : b + ' bed' });
    for (const s of state.excluded || []) t.push({ key: 'exclude:' + s.name, text: 'not ' + s.name });
    for (const [k, v] of Object.entries(state.wants || {})) if (v) t.push({ key: 'want:' + k, text: WANTS[k]?.label || k });
    return t;
  }
  const WANTS = {
    quiet: { label: 'quiet street', lens: 'road' },
    sun: { label: 'sun at ground level', lens: 'sun' },
    trees: { label: 'trees', lens: 'canopy' },
    land: { label: 'no notified land record within 1 km', lens: 'land' },
    flight: { label: 'away from the flight path', lens: 'flight' },
  };

  return { filterRents, quantile, weekly, pointInGeometry, norm, editDistance, classifyWhere, parsePrice, searchSuburbs, filterSales, median, monthsAgo, minusMonths, money, metres, nearestOnLines, pointInRing, solarPosition, daylightMinutes, sunMinutesAtPoint, selectionLine, WANTS };
});
