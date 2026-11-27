// SHOWHAUS Room: a segmented object → a small 3D asset.
// The front surface is the photo's relative depth inside the mask, the back mirrors it, the silhouette is stitched
// with side walls. It is a 2.5D relief from one photo (the hidden side is guessed), labelled as such in the page.

// Typical sizes (metres) for detector labels. `by` names the dimension we trust most for that kind of object;
// the other two follow the photo's proportions (and the depth ratio below). Unknown labels ask the visitor.
export const PRIORS = {
  couch: { by: 'w', w: 2.0, h: 0.85, d: 0.92 }, chair: { by: 'h', w: 0.5, h: 0.86, d: 0.55 }, bed: { by: 'w', w: 1.55, h: 1.0, d: 2.05 },
  'dining table': { by: 'h', w: 1.6, h: 0.75, d: 0.9 }, tv: { by: 'w', w: 1.25, h: 0.72, d: 0.08 }, 'potted plant': { by: 'h', w: 0.5, h: 0.9, d: 0.5 },
  vase: { by: 'h', w: 0.18, h: 0.32, d: 0.18 }, refrigerator: { by: 'h', w: 0.7, h: 1.8, d: 0.7 }, bench: { by: 'w', w: 1.2, h: 0.45, d: 0.4 },
  oven: { by: 'w', w: 0.6, h: 0.6, d: 0.6 }, microwave: { by: 'w', w: 0.5, h: 0.3, d: 0.38 }, toilet: { by: 'h', w: 0.38, h: 0.78, d: 0.68 },
  sink: { by: 'w', w: 0.6, h: 0.2, d: 0.45 }, laptop: { by: 'w', w: 0.33, h: 0.23, d: 0.23 }, clock: { by: 'w', w: 0.3, h: 0.3, d: 0.05 },
  'teddy bear': { by: 'h', w: 0.3, h: 0.4, d: 0.25 }, book: { by: 'h', w: 0.16, h: 0.24, d: 0.03 }, suitcase: { by: 'h', w: 0.45, h: 0.68, d: 0.27 },
  bicycle: { by: 'w', w: 1.75, h: 1.05, d: 0.6 },
  // everyday things people also tap (probe 27 Nov: a remote came out 2.55 m wide, a sitting cat 80 cm tall)
  cat: { by: 'h', w: 0.4, h: 0.3, d: 0.22 }, dog: { by: 'h', w: 0.7, h: 0.55, d: 0.3 }, person: { by: 'h', w: 0.5, h: 1.7, d: 0.3 },
  remote: { by: 'w', w: 0.2, h: 0.05, d: 0.05 }, 'cell phone': { by: 'w', w: 0.075, h: 0.155, d: 0.01 }, keyboard: { by: 'w', w: 0.44, h: 0.03, d: 0.14 },
  mouse: { by: 'w', w: 0.065, h: 0.04, d: 0.11 }, bowl: { by: 'w', w: 0.2, h: 0.08, d: 0.2 }, cup: { by: 'h', w: 0.08, h: 0.1, d: 0.08 },
  bottle: { by: 'h', w: 0.08, h: 0.28, d: 0.08 }, 'wine glass': { by: 'h', w: 0.08, h: 0.2, d: 0.08 }, banana: { by: 'w', w: 0.19, h: 0.04, d: 0.04 },
  apple: { by: 'w', w: 0.08, h: 0.08, d: 0.08 }, orange: { by: 'w', w: 0.08, h: 0.08, d: 0.08 }, backpack: { by: 'h', w: 0.3, h: 0.45, d: 0.18 },
  handbag: { by: 'w', w: 0.32, h: 0.25, d: 0.14 }, umbrella: { by: 'h', w: 0.1, h: 0.9, d: 0.1 }, scissors: { by: 'w', w: 0.2, h: 0.08, d: 0.01 },
};
// One tap instead of a tape when nothing says how big a thing is (same chips as the Android app's Rough).
export const ROUGH = [['hand', 'Hand', 0.15], ['knee', 'Knee', 0.5], ['waist', 'Waist', 0.9], ['person', 'Person', 1.7]];
// Typical sizes for things the detector has no label for, matched on the name the visitor types.
const NAMED = [[/coffee table|커피\s*테이블|좌탁/i, 'coffee table', { by: 'h', w: 1.1, h: 0.42, d: 0.6 }], [/side ?board|buffet|tv unit|tv stand|credenza|거실장|수납장/i, 'sideboard', { by: 'h', w: 1.8, h: 0.6, d: 0.45 }],
  [/rug|carpet|러그|카펫/i, 'rug', { by: 'w', w: 2.0, h: 0.01, d: 1.4 }], [/desk|책상/i, 'desk', { by: 'h', w: 1.2, h: 0.74, d: 0.6 }], [/wardrobe|closet|옷장/i, 'wardrobe', { by: 'h', w: 1.2, h: 2.0, d: 0.6 }],
  [/bookshelf|bookcase|shelf|책장|선반/i, 'bookshelf', { by: 'h', w: 0.8, h: 1.8, d: 0.3 }], [/floor lamp|lamp|스탠드|조명/i, 'floor lamp', { by: 'h', w: 0.4, h: 1.6, d: 0.4 }],
  [/armchair|안락의자/i, 'armchair', { by: 'h', w: 0.85, h: 0.85, d: 0.85 }], [/ottoman|stool|스툴/i, 'stool', { by: 'h', w: 0.45, h: 0.45, d: 0.45 }], [/drawers|dresser|서랍장/i, 'chest of drawers', { by: 'h', w: 0.9, h: 0.9, d: 0.45 }],
  [/bedside|nightstand|협탁/i, 'bedside table', { by: 'h', w: 0.45, h: 0.55, d: 0.4 }], [/mirror|거울/i, 'mirror', { by: 'h', w: 0.6, h: 1.6, d: 0.04 }]];
// How far a real one of a kind usually strays from the typical size [low, high] (same numbers as the Android app's Kind.kt).
const RANGE = { couch: [0.75, 1.35], armchair: [0.85, 1.2], chair: [0.85, 1.2], 'dining table': [0.6, 1.4], 'coffee table': [0.7, 1.3], desk: [0.75, 1.4],
  bed: [0.6, 1.25], sideboard: [0.65, 1.3], bookshelf: [0.7, 1.3], wardrobe: [0.7, 1.4], 'bedside table': [0.8, 1.25], 'floor lamp': [0.8, 1.2],
  rug: [0.6, 1.6], 'potted plant': [0.5, 1.8], 'chest of drawers': [0.75, 1.3], stool: [0.8, 1.3], bench: [0.7, 1.4], tv: [0.6, 1.5] };
export const rangeOf = label => RANGE[label] || (PRIORS[label] ? [0.75, 1.35] : [0.5, 1.8]);
// Kinds drawn as a clean shape at the given size instead of the one-photo relief (which read as a crumpled slab).
const SHAPE = { couch: 'sofa', armchair: 'sofa', chair: 'chair', 'dining table': 'table', 'coffee table': 'table', desk: 'table', bench: 'table', stool: 'table',
  bed: 'bed', sideboard: 'cabinet', bookshelf: 'shelf', wardrobe: 'cabinet', 'chest of drawers': 'cabinet', 'bedside table': 'cabinet', refrigerator: 'cabinet',
  oven: 'cabinet', microwave: 'cabinet', 'floor lamp': 'lamp', rug: 'rug', 'potted plant': 'plant', tv: 'panel' };
export const shapeOf = label => SHAPE[label] || null;
// Things that hold other things: Smaller on one of these means "just what's on it".
export const SURFACES = new Set(['dining table', 'coffee table', 'desk', 'bed', 'bench', 'sideboard', 'bedside table', 'chest of drawers']);
export function priorForName(name) { const hit = NAMED.find(([re]) => re.test(name || '')); if (hit) PRIORS[hit[1]] = hit[2]; return hit ? hit[1] : null; }
export const LIGHT_HINT = /lamp|light|조명|램프|스탠드|pendant|chandelier/i;

// pxW/pxH: the mask's bounding box in pixels.
// roughH: the visitor's one-tap height (ROUGH) for a thing with no typical size; without it there is no honest number yet.
export function estimate(label, pxW, pxH, roughH) {
  const p = PRIORS[label];
  const rk = rangeOf(label);
  if (!p) {
    if (!roughH) return { w: null, h: null, d: null, basis: 'unknown', rk, note: 'No typical size for this kind of thing. About how tall is it?' };
    const h = roughH, w = +(h * pxW / pxH).toFixed(2);
    return { w, h, d: +Math.min(w, h).toFixed(2), basis: 'rough', rk: [0.6, 1.6], note: `About ${h} m tall (your pick), the rest from the photo; it could be ${(w * 0.6).toFixed(2)}–${(w * 1.6).toFixed(2)} m wide.` };
  }
  const ratio = pxW / pxH, out = { basis: 'prior' };
  const other = p.by === 'w' ? 'h' : 'w', fromPhoto = p.by === 'w' ? p.w / ratio : p.h * ratio;
  out[p.by] = p[p.by];
  // a photo taken at an angle bends the proportions; past ±35 % of the typical size, the typical size is the better guess
  const bent = Math.abs(fromPhoto / p[other] - 1) > 0.35;
  out[other] = +(bent ? p[other] : fromPhoto).toFixed(2); out.d = p.d;
  out.note = `Typical ${label === 'couch' ? 'sofa' : label}: ${p.by === 'w' ? 'width' : 'height'} ${p[p.by]} m${bent ? `, ${other === 'h' ? 'height' : 'width'} ${p[other]} m (the photo is at an angle)` : ', the rest from the photo’s proportions'}.`;
  const [lo, hi] = rk; out.rk = rk;
  out.note += ` Real ones run ${(out.w * lo).toFixed(1)}–${(out.w * hi).toFixed(1)} m wide.`;
  return out;
}

// Mask + photo + depth → { tex (PNG data URL, transparent outside the mask), gw, gh, depth (per cell 0..1, -1 = empty), px }
export function capture(a, mask) {
  const W = a.img.width, H = a.img.height;
  mask = largest(mask, W, H);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, sc = Math.min(1, 640 / Math.max(bw, bh));
  const cv = document.createElement('canvas'); cv.width = Math.round(bw * sc); cv.height = Math.round(bh * sc);
  const src = document.createElement('canvas'); src.width = W; src.height = H; const sg = src.getContext('2d');
  const id = sg.createImageData(W, H), d = a.img.data, ch = a.img.channels;
  for (let i = 0; i < W * H; i++) { id.data[i * 4] = d[i * ch]; id.data[i * 4 + 1] = d[i * ch + 1]; id.data[i * 4 + 2] = d[i * ch + 2]; id.data[i * 4 + 3] = mask[i] ? 255 : 0; }
  sg.putImageData(id, 0, 0);
  cv.getContext('2d').drawImage(src, x0, y0, bw, bh, 0, 0, cv.width, cv.height);
  // depth grid over the box, one sample per cell centre
  const gw = Math.max(10, Math.min(112, Math.round(112 * Math.min(1, bw / bh)))), gh = Math.max(10, Math.min(140, Math.round(gw * bh / bw)));
  const raw = new Float32Array(gw * gh).fill(-1), vals = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = Math.min(W - 1, Math.round(x0 + (i + 0.5) / gw * bw)), y = Math.min(H - 1, Math.round(y0 + (j + 0.5) / gh * bh));
    if (mask[y * W + x]) { raw[j * gw + i] = a.depth[y * W + x]; vals.push(raw[j * gw + i]); }
  }
  vals.sort((p, q) => p - q); const lo = vals[Math.floor(vals.length * 0.05)] ?? 0, hi = vals[Math.floor(vals.length * 0.95)] ?? 1;
  const depth = raw.map(v => v < 0 ? -1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))));
  // thumbnail: object on the dark tile it is shown on
  const th = document.createElement('canvas'); th.width = th.height = 160; const tg = th.getContext('2d'), k = Math.min(140 / cv.width, 140 / cv.height);
  tg.drawImage(cv, (160 - cv.width * k) / 2, (160 - cv.height * k) / 2, cv.width * k, cv.height * k);
  return { rgb: medianRGB(a, mask), tex: cv.toDataURL('image/png'), thumb: th.toDataURL('image/png'), gw, gh, depth: Array.from(depth, v => +v.toFixed(3)), px: [bw, bh] };
}

// Asset → THREE.Group standing on y = 0, centred on x/z, sized dims {w,h,d} metres.
const texCache = new Map();
export function buildMesh(THREE, asset, dims, { glow = false, kind, ghost } = {}) {
  const shape = shapeOf(kind ?? asset.kind ?? asset.label);
  const grp = shape ? buildShape(THREE, shape, dims, asset, glow) : buildRelief(THREE, asset, dims, { glow });
  if (ghost) { const g = new THREE.Mesh(new THREE.BoxGeometry(ghost.w, ghost.h, ghost.d), new THREE.MeshBasicMaterial({ color: '#e8743b', transparent: true, opacity: 0.1, depthWrite: false }));
    g.position.y = ghost.h / 2; const e = new THREE.LineSegments(new THREE.EdgesGeometry(g.geometry), new THREE.LineDashedMaterial({ color: '#ffb27a', dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.8 }));
    e.computeLineDistances(); g.add(e); grp.add(g); }
  return grp;
}

// Plain parts at the real size, coloured from the photo. Same shapes as the Android app's Shapes.kt.
function buildShape(THREE, kind, { w, d: dd, h }, asset, glow) {
  const grp = new THREE.Group(), col = new THREE.Color(...(asset.rgb || [203, 187, 165]).map(v => v / 255)).convertSRGBToLinear();
  const mat = (c, r = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const body = mat(col), soft = mat(col.clone().lerp(new THREE.Color(1, 1, 1), 0.1), 0.95), dark = mat(new THREE.Color('#3b3129').convertSRGBToLinear(), 0.6);
  const box = (bw, bh, bd, x, y, z, m = body) => { const o = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m); o.position.set(x, y + bh / 2, z); o.castShadow = o.receiveShadow = true; grp.add(o); };
  const cyl = (r, ch, x, y, z, m) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, ch, 28), m); o.position.set(x, y + ch / 2, z); o.castShadow = true; grp.add(o); };
  const legs = (lw, ld, lh, t = 0.045) => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(t, lh, t, sx * (lw / 2 - t), 0, sz * (ld / 2 - t), dark); };
  if (kind === 'sofa') { const seat = h * 0.5, arm = Math.min(0.22, Math.max(0.1, w * 0.11)), back = Math.min(0.28, Math.max(0.14, dd * 0.22));
    box(w, 0.08, dd * 0.96, 0, 0, 0, dark); box(w, seat - 0.08, dd, 0, 0.08, 0); box(w - 2 * arm, 0.12, dd - back - 0.02, 0, seat - 0.02, back / 2, soft);
    box(w - 2 * arm, h - seat, back, 0, seat, -dd / 2 + back / 2); for (const sx of [-1, 1]) box(arm, h * 0.68 - 0.08, dd, sx * (w / 2 - arm / 2), 0.08, 0); }
  else if (kind === 'chair') { const sy = h * 0.52; legs(w * 0.92, dd * 0.92, sy, 0.035); box(w, 0.06, dd, 0, sy, 0, soft); box(w, h - sy - 0.06, 0.05, 0, sy + 0.06, -dd / 2 + 0.025); }
  else if (kind === 'table') { const top = h < 0.5 ? 0.05 : 0.035; legs(w * 0.96, dd * 0.94, h - top, h < 0.5 ? 0.06 : 0.05); box(w, top, dd, 0, h - top, 0); }
  else if (kind === 'bed') { const fr = h * 0.3; box(w, fr, dd, 0, 0, 0, dark); box(w - 0.04, 0.22, dd - 0.08, 0, fr, 0.02, soft); box(w, h, 0.07, 0, 0, -dd / 2 + 0.035);
    for (const sx of [-1, 1]) box(w * 0.38, 0.12, 0.36, sx * w * 0.23, fr + 0.22, -dd / 2 + 0.3, soft); }
  else if (kind === 'cabinet' || kind === 'shelf') { box(w, 0.06, dd * 0.94, 0, 0, 0, dark); box(w, h - 0.06, dd, 0, 0.06, 0);
    if (kind === 'shelf') { const n = Math.max(2, Math.floor(h / 0.35)); for (let i = 1; i < n; i++) box(w - 0.04, 0.02, 0.01, 0, h * i / n, dd / 2 + 0.005, dark); }
    else { const n = w > 1.5 ? 3 : w > 0.9 ? 2 : 1; for (let i = 0; i < n; i++) box(w / n - 0.02, h - 0.1, 0.01, -w / 2 + w / n * (i + 0.5), 0.08, dd / 2 + 0.005, soft); } }
  else if (kind === 'lamp') { const sh = Math.min(0.4, Math.max(0.2, h * 0.22)); cyl(w * 0.35, 0.03, 0, 0, 0, dark); cyl(0.015, h - sh, 0, 0.03, 0, dark);
    cyl(w / 2, sh, 0, h - sh, 0, new THREE.MeshStandardMaterial({ color: '#f3e3c3', roughness: 1, ...(glow ? { emissive: '#ffd9a0', emissiveIntensity: 1.2 } : {}) })); }
  else if (kind === 'rug') box(w, Math.max(h, 0.01), dd, 0, 0, 0, soft);
  else if (kind === 'plant') { const ph = h * 0.32; cyl(w * 0.28, ph, 0, 0, 0, mat(new THREE.Color('#b9a58c').convertSRGBToLinear(), 0.9));
    const f = new THREE.Mesh(new THREE.SphereGeometry(w / 2, 24, 16), mat(col)); f.scale.y = (h - ph) / w; f.position.y = ph + (h - ph) / 2; f.castShadow = true; grp.add(f); }
  else /* panel */ box(w, h, Math.max(dd, 0.03), 0, 0, 0, dark);
  return grp;
}

function buildRelief(THREE, asset, dims, { glow = false } = {}) {
  const { gw, gh, depth } = asset, { w, h, d } = dims, cell = (i, j) => i >= 0 && j >= 0 && i < gw && j < gh && depth[j * gw + i] >= 0;
  // vertex depth = mean of the masked cells around it
  const vw = gw + 1, vh = gh + 1, vd = new Float32Array(vw * vh), used = new Uint8Array(vw * vh);
  for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) { let s = 0, c = 0;
    for (const [a, b] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) if (cell(a, b)) { s += depth[b * gw + a]; c++; }
    if (c) { vd[j * vw + i] = s / c; used[j * vw + i] = 1; } }
  // the photo's depth is noisy inside one object (folds, cushions read as dents): smooth it hard so the surface is
  // a calm bulge, then round the silhouette by thinning it toward the edge
  let sm = vd.slice();
  for (let pass = 0; pass < 6; pass++) { const nx = sm.slice(); for (let j = 1; j < vh - 1; j++) for (let i = 1; i < vw - 1; i++) if (used[j * vw + i]) { let s = 0, c = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if (used[(j + b) * vw + i + a]) { s += sm[(j + b) * vw + i + a]; c++; } nx[j * vw + i] = s / c; } sm = nx; }
  const edge = new Float32Array(vw * vh).fill(0); // 0 at the silhouette, 1 a few cells in
  for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) if (used[j * vw + i]) { let r = 1;
    for (let k = 1; k <= 4 && r === 1; k++) for (const [a, b] of [[k, 0], [-k, 0], [0, k], [0, -k]]) { const x = i + a, y = j + b; if (x < 0 || y < 0 || x >= vw || y >= vh || !used[y * vw + x]) { r = (k - 1) / 4; break; } }
    edge[j * vw + i] = r; }
  const P = [], UV = [], C = [];
  const zf = k => d / 2 * (0.35 + 0.65 * Math.sqrt(edge[k])) * (0.8 + 0.2 * sm[k]), vx = i => (i / gw - 0.5) * w, vy = j => (1 - j / gh) * h;
  const V = (i, j, back, uv) => { const k = j * vw + i; P.push(vx(i), vy(j), back ? -zf(k) * 0.85 : zf(k)); UV.push(...(uv || [i / gw, 1 - j / gh])); const s = back ? 0.62 : uv ? 0.92 : 1; C.push(s, s, s); };
  const tri = (a, b, c) => { V(...a); V(...b); V(...c); };
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    if (!cell(i, j)) continue;
    tri([i, j, 0], [i, j + 1, 0], [i + 1, j + 1, 0]); tri([i, j, 0], [i + 1, j + 1, 0], [i + 1, j, 0]); // front, facing +z
    tri([i, j, 1], [i + 1, j + 1, 1], [i, j + 1, 1]); tri([i, j, 1], [i + 1, j, 1], [i + 1, j + 1, 1]); // back
    const cu = [(i + 0.5) / gw, 1 - (j + 0.5) / gh]; // side walls take the colour of the cell they close, never the transparent edge
    const side = (a, b) => { tri([...a, 0, cu], [...a, 1, cu], [...b, 1, cu]); tri([...a, 0, cu], [...b, 1, cu], [...b, 0, cu]); };
    if (!cell(i - 1, j)) side([i, j + 1], [i, j]); if (!cell(i + 1, j)) side([i + 1, j], [i + 1, j + 1]);
    if (!cell(i, j - 1)) side([i, j], [i + 1, j]); if (!cell(i, j + 1)) side([i + 1, j + 1], [i, j + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  let tex = texCache.get(asset.tex);
  if (!tex) { tex = new THREE.TextureLoader().load(asset.tex); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; texCache.set(asset.tex, tex); }
  const m = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.75, alphaTest: 0.35, side: THREE.DoubleSide,
    ...(glow ? { emissive: '#ffd9a0', emissiveMap: tex, emissiveIntensity: 0.9 } : {}) });
  const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; /* no self-shadowing: a one-photo relief gets shadow acne */
  const grp = new THREE.Group(); grp.add(mesh); return grp;
}

// median colour of the cut-out: the fabric or wood, not a highlight or a cushion
function medianRGB(a, mask) { const d = a.img.data, ch = a.img.channels, rs = [], gs = [], bs = [], step = Math.max(1, Math.floor(mask.length / 6000));
  for (let i = 0; i < mask.length; i += step) if (mask[i]) { rs.push(d[i * ch]); gs.push(d[i * ch + 1]); bs.push(d[i * ch + 2]); }
  const med = v => v.sort((p, q) => p - q)[v.length >> 1] ?? 160; return [med(rs), med(gs), med(bs)]; }
// keep the biggest connected piece of a mask (drops bits of the chair behind the sofa)
function largest(mask, W, H) {
  const lab = new Int32Array(W * H), q = new Int32Array(W * H); let best = 0, bestN = 0, id = 0;
  for (let s = 0; s < W * H; s++) { if (!mask[s] || lab[s]) continue; id++; let h = 0, t = 0, n = 0; q[t++] = s; lab[s] = id;
    while (h < t) { const i = q[h++]; n++; const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < W * H && mask[j] && !lab[j]) { lab[j] = id; q[t++] = j; } }
    if (n > bestN) { bestN = n; best = id; } }
  const out = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) out[i] = lab[i] === best ? 1 : 0; return out;
}
