// SHOWHAUS live room: plan JSON → a three.js scene in the browser, no server bake. Realtime hemisphere + sun light,
// cheap ambient occlusion (contact shadows under furniture, darkened wall/floor seams). Used by the arrange page
// (dist/showhaus/arrange) and available to the walk viewer for homes that have a plan but no baked scene yet.
// Plan coords: x east, y north, metres. three: x = x, y = up, z = -y.
import { CATALOGUE, edges, wallBoxes, bounds, rectOf } from './plan-core.js';

const FLOOR = { oak: '#b98d5f', tile: '#d9d5cd', concrete: '#a8a59f', carpet: '#9b9387' };
const rgb = (c, THREE) => Array.isArray(c) ? new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace) : new THREE.Color(c);

export function ceilingFn(plan) {
  const c = plan.ceiling || { type: 'flat', h: 2.7 };
  if (c.type !== 'raked') return () => c.h || 2.7;
  const [x0, y0] = c.from, [x1, y1] = c.to, dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
  return (x, y) => c.h0 + ((x - x0) * dx + (y - y0) * dy) / L2 * (c.h1 - c.h0);
}

// A prism over a 4-point plan footprint from z0 up to top(x, y): flat-shaded, non-indexed.
function prism(THREE, foot, z0, top) {
  const P = [], q = foot.map(([x, y]) => ({ x, y, t: typeof top === 'function' ? top(x, y) : top }));
  const v = (p, z) => [p.x, z, -p.y], tri = (a, b, c) => P.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  // make the footprint counter-clockwise so outward faces point out
  let s = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; }
  if (s < 0) q.reverse();
  quad(v(q[0], q[0].t), v(q[1], q[1].t), v(q[2], q[2].t), v(q[3], q[3].t));
  quad(v(q[3], z0), v(q[2], z0), v(q[1], z0), v(q[0], z0));
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; quad(v(a, z0), v(b, z0), v(b, b.t), v(a, a.t)); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals();
  return g;
}
const rectFoot = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function gradientTexture(THREE, kind) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const gr = kind === 'radial' ? g.createRadialGradient(32, 32, 4, 32, 32, 32) : g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(kind === 'radial' ? 0.55 : 0.35, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function plankTexture(THREE, base) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 8; i++) { // planks 32 px wide, staggered joints, faint grain
    g.fillStyle = `rgba(${i % 2 ? '255,255,255' : '0,0,0'},${0.03 + (i * 37 % 5) / 100})`; g.fillRect(i * 32, 0, 32, 256);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(i * 32, 0, 1, 256); g.fillRect(i * 32, (i * 97) % 256, 32, 1);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

export function buildRoom(THREE, plan, opts = {}) {
  const root = new THREE.Group(), ceil = ceilingFn(plan), T = plan.wall_t || 0.11, F = plan.finishes || {};
  const mats = new Map();
  const mat = (color, extra = {}) => { const k = color + JSON.stringify(extra); if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: rgb(color, THREE), roughness: 0.85, metalness: 0, ...extra })); return mats.get(k); };
  const add = (g, m, parent = root, cast = true) => { const me = new THREE.Mesh(g, m); me.castShadow = cast; me.receiveShadow = true; parent.add(me); return me; };
  const wallM = mat(F.wall ? '#' + rgb(F.wall, THREE).getHexString() : '#f1eee8'), [bx0, by0, bx1, by1] = bounds(plan.outline);

  // ---- floor, ceiling, ground
  const shape = new THREE.Shape(plan.outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const floorG = new THREE.ShapeGeometry(shape); floorG.rotateX(-Math.PI / 2);
  const uv = floorG.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 1.6, uv.getY(i) / 1.6);
  const fcol = FLOOR[F.floor] || FLOOR.oak;
  const floor = add(floorG, new THREE.MeshStandardMaterial({ color: '#ffffff', map: (F.floor || 'oak') === 'oak' ? plankTexture(THREE, fcol) : null, roughness: 0.7, ...((F.floor || 'oak') === 'oak' ? {} : { color: fcol }) }), root, false);
  floor.name = 'floor';
  const floors = [floor];
  for (const o of plan.outdoor || []) {
    const [x0, y0, x1, y1] = o.rect, g = new THREE.PlaneGeometry(x1 - x0, y1 - y0); g.rotateX(-Math.PI / 2); g.translate((x0 + x1) / 2, -0.02, -(y0 + y1) / 2);
    const m = add(g, mat('#b7aea0'), root, false); m.name = 'floor'; floors.push(m);
  }
  const ground = new THREE.PlaneGeometry(200, 200); ground.rotateX(-Math.PI / 2); ground.translate((bx0 + bx1) / 2, -0.06, -(by0 + by1) / 2);
  add(ground, mat('#8fa27d'), root, false);
  const ceilingMesh = (() => {
    const g = new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, ceil(p.getX(i), -p.getZ(i)));
    g.computeVertexNormals(); const m = add(g, new THREE.MeshStandardMaterial({ color: '#f7f5f0', emissive: '#5a5852', side: THREE.DoubleSide, roughness: 0.95 }), root, false);
    m.castShadow = false; m.visible = opts.ceiling !== false; return m;
  })();

  // ---- outline walls, cut around openings
  const glass = new THREE.MeshStandardMaterial({ color: '#bcd7ea', transparent: true, opacity: 0.25, roughness: 0.05 });
  const frameM = mat('#3d3d3d'), doorM = mat('#d9d2c4');
  const walls = new THREE.Group(); root.add(walls);
  edges(plan.outline).forEach(([a, b], i) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]]; // outward normal for CCW
    const at = (u, v) => [a[0] + d[0] * u + n[0] * v, a[1] + d[1] * u + n[1] * v];
    const piece = (u0, u1, z0 = 0, z1 = null) => { if (u1 - u0 < 1e-3) return; const f = [at(u0, 0), at(u1, 0), at(u1, T), at(u0, T)];
      add(prism(THREE, f, z0, z1 == null ? ceil : z1), wallM, walls); };
    const horiz = Math.abs(d[0]) > 0.5, base = horiz ? a[0] : a[1], sgn = horiz ? d[0] : d[1];
    const ops = (plan.openings || []).filter(o => o.edge === i).map(o => { const [u0, u1] = [(o.a - base) * sgn, (o.b - base) * sgn].sort((p, q) => p - q); return { ...o, u0, u1 }; }).sort((p, q) => p.u0 - q.u0);
    let u = 0;
    for (const o of ops) {
      piece(u, o.u0); const head = o.head || 2.1;
      const top = (x, y) => Math.max(head + 0.01, ceil(x, y));
      add(prism(THREE, [at(o.u0, 0), at(o.u1, 0), at(o.u1, T), at(o.u0, T)], head, top), wallM, walls);
      if (o.type === 'window') add(prism(THREE, [at(o.u0, 0), at(o.u1, 0), at(o.u1, T), at(o.u0, T)], 0, o.sill || 0.9), wallM, walls);
      const z0 = o.type === 'window' ? (o.sill || 0.9) : 0;
      if (o.type === 'door') add(prism(THREE, [at(o.u0 + 0.02, T * 0.4), at(o.u1 - 0.02, T * 0.4), at(o.u1 - 0.02, T * 0.6), at(o.u0 + 0.02, T * 0.6)], 0, head - 0.01), doorM, walls);
      else {
        add(prism(THREE, [at(o.u0, T * 0.48), at(o.u1, T * 0.48), at(o.u1, T * 0.52), at(o.u0, T * 0.52)], z0, head), glass, walls, false);
        const k = (o.mullions || 0) + 1;
        for (let m = 0; m <= k; m++) { const uu = o.u0 + (o.u1 - o.u0) * m / k; add(prism(THREE, [at(uu - 0.02, T * 0.4), at(uu + 0.02, T * 0.4), at(uu + 0.02, T * 0.6), at(uu - 0.02, T * 0.6)], z0, head), frameM, walls); }
      }
      u = o.u1;
    }
    piece(u, L);
    // corner post closing the outside corner at b when the turn is convex
    const c = plan.outline[(i + 2) % plan.outline.length], cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross > 0) { const n2 = [(c[1] - b[1]) / Math.hypot(c[0] - b[0], c[1] - b[1]), -(c[0] - b[0]) / Math.hypot(c[0] - b[0], c[1] - b[1])];
      const q = (s, t) => [b[0] + n[0] * s + n2[0] * t, b[1] + n[1] * s + n2[1] * t]; add(prism(THREE, [q(0, 0), q(T, 0), q(T, T), q(0, T)], 0, ceil), wallM, walls); }
  });
  // ---- internal walls (multi-room plans) with headers over the door gaps
  for (const w of wallBoxes(plan)) add(prism(THREE, rectFoot(w), 0, ceil), wallM, walls);
  for (const w of plan.walls || []) for (const g of w.doors || []) {
    const t = (w.t || 0.09) / 2, horiz = Math.abs(w.to[1] - w.from[1]) < 1e-6, head = g.head || 2.1;
    const r = horiz ? [Math.min(g.a, g.b), w.from[1] - t, Math.max(g.a, g.b), w.from[1] + t] : [w.from[0] - t, Math.min(g.a, g.b), w.from[0] + t, Math.max(g.a, g.b)];
    add(prism(THREE, rectFoot(r), head, (x, y) => Math.max(head + 0.01, ceil(x, y))), wallM, walls);
  }

  // ---- cheap ambient occlusion: a dark gradient strip along every wall foot, and contact shadows under furniture
  const seam = new THREE.MeshBasicMaterial({ map: gradientTexture(THREE, 'linear'), transparent: true, opacity: 0.32, depthWrite: false });
  const strip = (x0, y0, x1, y1, inward) => { // strip on the floor from the wall line inward 0.35 m
    const L = Math.hypot(x1 - x0, y1 - y0), g = new THREE.PlaneGeometry(L, 0.35); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, seam); m.position.set((x0 + x1) / 2 + inward[0] * 0.175, 0.004, -((y0 + y1) / 2 + inward[1] * 0.175));
    m.rotation.y = Math.atan2(inward[0], -inward[1]); /* local +v (the dark edge of the texture) points at the wall */ m.renderOrder = 1; root.add(m); };
  for (const [a, b] of edges(plan.outline)) { const L = Math.hypot(b[0] - a[0], b[1] - a[1]); strip(a[0], a[1], b[0], b[1], [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]); }
  for (const w of wallBoxes(plan)) { const horiz = w[2] - w[0] > w[3] - w[1];
    if (horiz) { strip(w[0], w[1], w[2], w[1], [0, -1]); strip(w[0], w[3], w[2], w[3], [0, 1]); } else { strip(w[0], w[1], w[0], w[3], [-1, 0]); strip(w[2], w[1], w[2], w[3], [1, 0]); } }
  const blob = new THREE.MeshBasicMaterial({ map: gradientTexture(THREE, 'radial'), transparent: true, opacity: 0.5, depthWrite: false });

  // ---- lights: sky + bounce, and a sun from the north (Sydney) that casts soft shadows
  const hemi = new THREE.HemisphereLight('#fdfbf5', '#8d8273', 1.9); root.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1dc', 1.6), cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, span = Math.max(bx1 - bx0, by1 - by0) + 6;
  sun.position.set(cx - 4, 9, -(cy + 7)); sun.target.position.set(cx, 0, -cy); sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: 40 }); sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -0.0008; sun.shadow.radius = 3;
  root.add(sun, sun.target);

  // ---- furniture
  const furn = new THREE.Group(); root.add(furn);
  function setItems(items, selected) {
    furn.clear();
    for (const it of items) {
      const g = new THREE.Group(), c = CATALOGUE[it.t] || CATALOGUE.box, col = it.color || c.color, w = it.w, d = it.d, h = it.h || c.h;
      const B = (u0, u1, v0, v1, z0, z1, color, extra) => add(prism(THREE, rectFoot([u0, v0, u1, v1]), z0, z1), mat(color, extra), g);
      const legs = (hw, hd, z1, color) => { for (const sx of [-1, 1]) for (const sy of [-1, 1]) B(sx * hw - 0.025, sx * hw + 0.025, sy * hd - 0.025, sy * hd + 0.025, 0, z1, color); };
      const W = w / 2, D = d / 2;
      switch (it.t) {
        case 'sofa': case 'armchair': {
          const arm = Math.min(0.18, w * 0.12);
          B(-W, W, -D, D, 0.08, 0.42, col); B(-W, W, -D, -D + 0.2, 0.42, h, col);
          B(-W, -W + arm, -D, D, 0.42, 0.62, col); B(W - arm, W, -D, D, 0.42, 0.62, col);
          B(-W + arm + 0.02, W - arm - 0.02, -D + 0.22, D - 0.04, 0.42, 0.5, '#ddd5c6'); legs(W - 0.05, D - 0.05, 0.08, '#3a3530'); break; }
        case 'bed':
          B(-W, W, -D, D, 0.05, 0.3, '#8c6a4c'); B(-W + 0.02, W - 0.02, -D + 0.06, D - 0.02, 0.3, 0.5, '#f4f1ea');
          B(-W + 0.01, W - 0.01, -D + 0.62, D - 0.01, 0.5, 0.54, it.color || '#b9573a'); B(-W, W, -D, -D + 0.06, 0.05, 1.05, '#8c6a4c');
          for (const s of w > 1.2 ? [-1, 1] : [0]) B(s * W / 2 - 0.3, s * W / 2 + 0.3, -D + 0.12, -D + 0.5, 0.5, 0.63, '#ffffff'); break;
        case 'coffee_table': case 'desk': case 'dining': case 'outdoor_table': {
          const dd = it.t === 'desk' ? Math.min(d, 0.75) : d, off = it.t === 'desk' ? -D + dd / 2 : 0;
          B(-W, W, off - dd / 2, off + dd / 2, h - 0.04, h, col); legs(W - 0.06, dd / 2 - 0.06, h - 0.04, '#3a3530');
          if (c.chairs || it.t === 'desk') {
            const n = it.t === 'desk' ? 1 : Math.max(1, Math.floor(w / 0.6)), seats = [];
            for (let k = 0; k < n; k++) { const u = -W + w * (k + 0.5) / n; seats.push([u, D + 0.3, 1]); if (it.t !== 'desk') seats.push([u, -D - 0.3, -1]); }
            if (it.t === 'desk') seats[0] = [0, off + dd / 2 - 0.05, 1]; /* chair tucked in: the desk's footprint is the desk */
            for (const [u, v, s] of seats) { B(u - 0.21, u + 0.21, v - 0.21, v + 0.21, 0.43, 0.47, '#4a423b'); B(u - 0.21, u + 0.21, v + s * 0.17, v + s * 0.21, 0.47, 0.88, '#4a423b'); }
          }
          break; }
        case 'tv_unit': B(-W, W, -D, D, 0.05, h, col); { const tw = Math.min(w * 0.8, 1.45); B(-tw / 2, tw / 2, -D + 0.05, -D + 0.09, h + 0.06, h + 0.06 + tw * 9 / 16, '#151515'); } break;
        case 'rug': B(-W, W, -D, D, 0.002, 0.012, col); break;
        case 'plant': B(-0.15, 0.15, -0.15, 0.15, 0, 0.35, '#c9b9a0'); add(new THREE.SphereGeometry(Math.max(0.25, w * 0.6), 12, 10).translate(0, 0.85, 0), mat(col), g); break;
        case 'floor_lamp': B(-0.12, 0.12, -0.12, 0.12, 0, 0.03, '#333'); B(-0.015, 0.015, -0.015, 0.015, 0, h - 0.3, '#333'); B(-0.17, 0.17, -0.17, 0.17, h - 0.3, h, '#f5ecd8', { emissive: '#f5d9a8', emissiveIntensity: 0.5 }); break;
        case 'kitchen_run': B(-W, W, -D, D, 0.1, 0.88, rgbHex(F.cabinet, '#e7e3dc')); B(-W - 0.02, W + 0.02, -D, D, 0.88, 0.92, rgbHex(F.stone, '#d9d6cf')); B(-W, W, -D, -D + 0.012, 0.92, 1.5, rgbHex(F.splash, '#ebe8e2')); break;
        case 'island': B(-W, W, -D, D, 0.1, 0.88, rgbHex(F.cabinet, '#e7e3dc')); B(-W - 0.05, W + 0.05, -D - 0.05, D + 0.05, 0.88, 0.92, rgbHex(F.stone, '#d9d6cf')); break;
        default: B(-W, W, -D, D, 0.02, h, col); // wardrobe, drawers, bookshelf, bedside, tall, fridge, my item
      }
      if (it.id === selected) g.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color('#e8743b'); o.material.emissiveIntensity = 0.35; } });
      g.position.set(it.x, 0, -it.y); g.rotation.y = (it.r || 0) * Math.PI / 180; furn.add(g);
      if (!c.flat) { const rc = rectOf(it), pg = new THREE.PlaneGeometry(rc[2] - rc[0] + 0.35, rc[3] - rc[1] + 0.35); pg.rotateX(-Math.PI / 2);
        const s = new THREE.Mesh(pg, blob); s.position.set((rc[0] + rc[2]) / 2, 0.006, -(rc[1] + rc[3]) / 2); s.renderOrder = 2; furn.add(s); }
    }
  }
  function rgbHex(c, fb) { return c ? '#' + rgb(c, THREE).getHexString() : fb; }
  return { root, floors, ceiling: ceilingMesh, walls, setItems, ceil, center: [cx, cy], span: Math.max(bx1 - bx0, by1 - by0) };
}
