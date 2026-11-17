// SHOWHAUS plan geometry shared by the arrange page (dist/showhaus/arrange) and the live room builder (plan-room.js).
// Pure functions, no DOM, no three.js: node tests import this file directly (scripts/showhaus-arrange.test.mjs).
// Plan JSON is the walk pipeline's schema (showhaus/walk-pipeline/README.md): metres, x = east, y = north.
// The catalogue sizes mirror walkgen.py ITEMS so a layout made here and a baked walk agree on every footprint.

// type → [length along local x, depth along local y, height, label, colour]; rot 0 = back to the south, facing north.
export const CATALOGUE = {
  sofa: { w: 2.3, d: 0.95, h: 0.85, label: 'Sofa', color: '#c9c0b0' },
  armchair: { w: 0.95, d: 0.92, h: 0.85, label: 'Armchair', color: '#b9a88f' },
  coffee_table: { w: 1.1, d: 0.6, h: 0.42, label: 'Coffee table', color: '#a77b52' },
  tv_unit: { w: 1.8, d: 0.44, h: 0.5, label: 'TV unit', color: '#5b5048' },
  dining: { w: 1.6, d: 0.9, h: 0.75, label: 'Dining table', color: '#a77b52', chairs: true },
  bed: { w: 1.59, d: 2.12, h: 0.5, label: 'Bed', color: '#e9e3d8' },
  bedside: { w: 0.45, d: 0.4, h: 0.55, label: 'Bedside', color: '#a77b52' },
  wardrobe: { w: 1.8, d: 0.6, h: 2.0, label: 'Wardrobe', color: '#d8d0c2' },
  drawers: { w: 1.2, d: 0.5, h: 0.9, label: 'Chest of drawers', color: '#b8946a' },
  bookshelf: { w: 0.9, d: 0.35, h: 1.8, label: 'Bookshelf', color: '#b8946a' },
  desk: { w: 1.4, d: 0.7, h: 0.75, label: 'Desk', color: '#cdb58f' },
  rug: { w: 2.4, d: 1.7, h: 0.01, label: 'Rug', color: '#cbb89a', flat: true },
  plant: { w: 0.42, d: 0.42, h: 1.2, label: 'Plant', color: '#4f7a4a' },
  floor_lamp: { w: 0.3, d: 0.3, h: 1.6, label: 'Floor lamp', color: '#e8e1d2' },
  outdoor_table: { w: 1.8, d: 0.9, h: 0.75, label: 'Outdoor table', color: '#8a8173', chairs: true },
  box: { w: 1.0, d: 0.6, h: 0.8, label: 'My item', color: '#8fa6bf' },
  // built into the plan: shown, not movable
  kitchen_run: { w: 3.0, d: 0.65, h: 0.9, label: 'Kitchen', color: '#d9d4ca', fixed: true },
  island: { w: 2.6, d: 0.94, h: 0.9, label: 'Island', color: '#d9d4ca', fixed: true },
  tall: { w: 1.8, d: 0.62, h: 2.2, label: 'Pantry', color: '#d9d4ca', fixed: true },
  fridge: { w: 0.92, d: 0.72, h: 1.8, label: 'Fridge', color: '#cfd3d6', fixed: true },
};
export const BED_W = { single: 0.98, double: 1.44, queen: 1.59, king: 1.89 };
// The palette a mover picks from (name, type, size). Sizes are common Australian retail sizes.
export const PALETTE = [ // beds and sofas first: the pieces movers check most (panel 2026-11-17: a landlord never scrolled to the beds)
  ['Queen bed', 'bed', 1.59, 2.12], ['Double bed', 'bed', 1.44, 2.0], ['3-seat sofa', 'sofa', 2.3, 0.95], ['King bed', 'bed', 1.89, 2.12], ['Single bed', 'bed', 0.98, 1.97],
  ['2-seat sofa', 'sofa', 1.7, 0.9], ['Dining 4', 'dining', 1.4, 0.9], ['Dining 6', 'dining', 1.8, 1.0], ['Desk', 'desk', 1.4, 0.7], ['Wardrobe', 'wardrobe', 1.8, 0.6],
  ['Armchair', 'armchair', 0.95, 0.92], ['Coffee table', 'coffee_table', 1.1, 0.6], ['TV unit', 'tv_unit', 1.8, 0.44], ['Bedside', 'bedside', 0.45, 0.4],
  ['Drawers', 'drawers', 1.2, 0.5], ['Bookshelf', 'bookshelf', 0.9, 0.35], ['Rug', 'rug', 2.4, 1.7], ['Plant', 'plant', 0.42, 0.42], ['Floor lamp', 'floor_lamp', 0.3, 0.3],
];

const r3 = v => Math.round(v * 1000) / 1000;
export const edges = poly => poly.map((a, i) => [a, poly[(i + 1) % poly.length]]);
export function inside(poly, x, y) {
  let c = false;
  for (const [[x0, y0], [x1, y1]] of edges(poly)) if ((y0 > y) !== (y1 > y) && x < x0 + (y - y0) * (x1 - x0) / (y1 - y0)) c = !c;
  return c;
}
export const bounds = poly => { const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };

// A plan item (walkgen schema) → an arrange item { id, t, x, y, r, w, d, h, label, fixed }.
export function fromPlanItem(it, i) {
  const c = CATALOGUE[it.type];
  if (!c || ['pendant', 'art'].includes(it.type)) return null; // ceiling and wall decor: not floor furniture
  let w = it.len ?? c.w, d = it.depth ?? c.d;
  if (it.type === 'bed') { w = BED_W[it.size || 'queen']; d = 2.12; }
  if (it.type === 'coffee_table' && it.size) { w = d = it.size; }
  if (it.type === 'dining') { w = it.len ?? 2.4; d = it.depth ?? 1.05; }
  if (it.type === 'box') { w = it.size[0]; d = it.size[1]; }
  return { id: 'p' + i, t: it.type, x: it.at[0], y: it.at[1], r: (it.rot || 0) % 360, w, d, h: c.h, label: c.label, fixed: !!c.fixed };
}

// Axis-aligned footprint of an arrange item [x0, y0, x1, y1]; a dining table's chairs add 0.45 m on each long side.
export function rectOf(it, withChairs = true) {
  const c = CATALOGUE[it.t] || CATALOGUE.box, ch = withChairs && c.chairs ? 0.45 : 0;
  const turned = it.r % 180 !== 0, w = turned ? it.d + 2 * ch : it.w, d = turned ? it.w : it.d + 2 * ch;
  return [r3(it.x - w / 2), r3(it.y - d / 2), r3(it.x + w / 2), r3(it.y + d / 2)];
}
export const overlaps = (a, b, eps = 0.005) => a[0] < b[2] - eps && b[0] < a[2] - eps && a[1] < b[3] - eps && b[1] < a[3] - eps;
const solid = it => !(CATALOGUE[it.t] || {}).flat;

// Internal walls (plan.walls, the multi-room extension): each { from, to, t, doors: [{ a, b }] } → solid segments [x0, y0, x1, y1]
// with the door gaps cut out. a..b is the absolute x (horizontal wall) or y (vertical wall), like openings on the outline.
export function wallBoxes(plan) {
  const out = [];
  for (const w of plan.walls || []) {
    const [ax, ay] = w.from, [bx, by] = w.to, t = (w.t || 0.09) / 2, horiz = Math.abs(by - ay) < 1e-6;
    const lo = horiz ? Math.min(ax, bx) : Math.min(ay, by), hi = horiz ? Math.max(ax, bx) : Math.max(ay, by);
    const gaps = (w.doors || []).map(g => [Math.min(g.a, g.b), Math.max(g.a, g.b)]).sort((p, q) => p[0] - q[0]);
    let s = lo;
    for (const [g0, g1] of [...gaps, [hi, hi]]) {
      if (g0 - s > 1e-6) out.push(horiz ? [r3(s), r3(ay - t), r3(g0), r3(ay + t)] : [r3(ax - t), r3(s), r3(ax + t), r3(g0)]);
      s = Math.max(s, g1);
    }
  }
  return out;
}

// Where furniture may stand: inside the outline (or wholly on an outdoor area), not through an internal wall.
export function rectInRoom(plan, rc) {
  const outdoor = (plan.outdoor || []).map(o => o.rect);
  if (outdoor.some(o => rc[0] >= o[0] - 1e-6 && rc[1] >= o[1] - 1e-6 && rc[2] <= o[2] + 1e-6 && rc[3] <= o[3] + 1e-6)) return true;
  const e = 0.002, o = plan.outline;
  for (const [x, y] of [[rc[0] + e, rc[1] + e], [rc[2] - e, rc[1] + e], [rc[2] - e, rc[3] - e], [rc[0] + e, rc[3] - e]]) if (!inside(o, x, y)) return false;
  // a reflex corner of the outline strictly inside the rectangle means a wall cuts through it
  for (const [x, y] of o) if (x > rc[0] + e && x < rc[2] - e && y > rc[1] + e && y < rc[3] - e) return false;
  // the rectangle can straddle a notch without containing a corner: test points along its edges
  for (let k = 1; k < 8; k++) {
    const fx = rc[0] + (rc[2] - rc[0]) * k / 8, fy = rc[1] + (rc[3] - rc[1]) * k / 8;
    if (!inside(o, fx, rc[1] + e) || !inside(o, fx, rc[3] - e) || !inside(o, rc[0] + e, fy) || !inside(o, rc[2] - e, fy)) return false;
  }
  return !wallBoxes(plan).some(w => overlaps(w, rc));
}

// Every wall face an item could be pushed against: { axis: 'x' | 'y', at, lo, hi, side } where side is the direction of
// free space (+1 = the room is on the larger-coordinate side of the face).
export function wallFaces(plan) {
  const faces = [], o = plan.outline;
  for (const [a, b] of edges(o)) {
    if (Math.abs(a[0] - b[0]) < 1e-6) faces.push({ axis: 'x', at: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), side: b[1] > a[1] ? -1 : 1 }); // CCW: going north, room is west
    else faces.push({ axis: 'y', at: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), side: b[0] > a[0] ? 1 : -1 });
  }
  for (const w of wallBoxes(plan)) {
    faces.push({ axis: 'x', at: w[0], lo: w[1], hi: w[3], side: -1 }, { axis: 'x', at: w[2], lo: w[1], hi: w[3], side: 1 });
    faces.push({ axis: 'y', at: w[1], lo: w[0], hi: w[2], side: -1 }, { axis: 'y', at: w[3], lo: w[0], hi: w[2], side: 1 });
  }
  return faces;
}

// Snap a dragged item: 5 cm grid, then flush against a wall face within `pull` metres.
export function snap(plan, it, pull = 0.12) {
  const g = v => Math.round(v / 0.05) * 0.05;
  const s = { ...it, x: r3(g(it.x)), y: r3(g(it.y)) };
  const rc = rectOf(s, false), hw = (rc[2] - rc[0]) / 2, hd = (rc[3] - rc[1]) / 2;
  let bx = null, by = null;
  for (const f of wallFaces(plan)) {
    if (f.axis === 'x' && rc[3] > f.lo && rc[1] < f.hi) {
      const want = f.side > 0 ? f.at + hw : f.at - hw, dist = Math.abs(want - s.x);
      if (dist < pull && (!bx || dist < bx[1])) bx = [want, dist];
    }
    if (f.axis === 'y' && rc[2] > f.lo && rc[0] < f.hi) {
      const want = f.side > 0 ? f.at + hd : f.at - hd, dist = Math.abs(want - s.y);
      if (dist < pull && (!by || dist < by[1])) by = [want, dist];
    }
  }
  if (bx) s.x = r3(bx[0]); if (by) s.y = r3(by[0]);
  return s;
}

// Clear distance from an item's four sides to the nearest wall or other solid item (metres, null = open/outdoor).
export function clearances(plan, items, it) {
  const rc = rectOf(it), out = { w: null, e: null, s: null, n: null };
  const blocks = wallFaces(plan).map(f => f.axis === 'x' ? [f.at, f.lo, f.at, f.hi] : [f.lo, f.at, f.hi, f.at]);
  for (const o of items) if (o !== it && o.id !== it.id && solid(o)) blocks.push(rectOf(o));
  const take = (k, v) => { if (v >= -1e-6 && (out[k] == null || v < out[k])) out[k] = r3(Math.max(0, v)); };
  for (const b of blocks) {
    if (b[3] > rc[1] + 1e-6 && b[1] < rc[3] - 1e-6) { if (b[2] <= rc[0] + 1e-6) take('w', rc[0] - b[2]); if (b[0] >= rc[2] - 1e-6) take('e', b[0] - rc[2]); }
    if (b[2] > rc[0] + 1e-6 && b[0] < rc[2] - 1e-6) { if (b[3] <= rc[1] + 1e-6) take('s', rc[1] - b[3]); if (b[1] >= rc[3] - 1e-6) take('n', b[1] - rc[3]); }
  }
  return out;
}

// Which items overlap another solid item (ids). Rugs never clash.
export function clashes(items) {
  const bad = new Set(), s = items.filter(solid);
  for (let i = 0; i < s.length; i++) for (let k = i + 1; k < s.length; k++) if (overlaps(rectOf(s[i]), rectOf(s[k]))) { bad.add(s[i].id); bad.add(s[k].id); }
  return bad;
}

// A plain rectangular room for people who only have a tape measure: W × D metres, a door on the south wall.
export function roomPlan(w, d, name) {
  w = Math.min(30, Math.max(1.5, Math.round(w * 100) / 100)); d = Math.min(30, Math.max(1.5, Math.round(d * 100) / 100));
  const door = Math.min(0.82, w - 0.3);
  return {
    slug: null, name: name || `My room ${w} × ${d} m`, source: 'measured', outline: [[0, 0], [w, 0], [w, d], [0, d]],
    ceiling: { type: 'flat', h: 2.7 }, openings: [{ edge: 0, type: 'door', a: r3(0.15), b: r3(0.15 + door), head: 2.1 }],
    items: [], assumptions: ['Room size as you measured it. Ceiling 2.7 m and the door position are placeholders.'],
  };
}

// Layout ⇄ the shape stored in a share link / localStorage. Bounded so a board stays small.
export const MAX_ITEMS = 80;
export function cleanLayout(L) {
  if (!L || typeof L !== 'object') return null;
  const num = (v, lo, hi) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v * 1000) / 1000)) : null;
  const plan = typeof L.plan === 'string' && /^[a-z0-9-]{3,80}$/.test(L.plan) ? L.plan : null;
  const room = L.room && typeof L.room === 'object' ? { w: num(L.room.w, 1.5, 30), d: num(L.room.d, 1.5, 30) } : null;
  if (!plan && !(room && room.w && room.d)) return null;
  const items = (Array.isArray(L.items) ? L.items : []).slice(0, MAX_ITEMS).map((i, k) => {
    if (!i || !CATALOGUE[i.t] || CATALOGUE[i.t].fixed) return null;
    const x = num(i.x, -50, 80), y = num(i.y, -50, 80), w = num(i.w, 0.1, 6), d = num(i.d, 0.1, 6);
    if ([x, y, w, d].includes(null)) return null;
    const label = String(i.label || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30);
    return { id: 'i' + k, t: i.t, x, y, r: [0, 90, 180, 270].includes(+i.r) ? +i.r : 0, w, d, h: num(i.h, 0.01, 3) ?? CATALOGUE[i.t].h, label: label || CATALOGUE[i.t].label };
  }).filter(Boolean);
  const title = String(L.title || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  return { plan, room: plan ? null : room, items, title };
}
