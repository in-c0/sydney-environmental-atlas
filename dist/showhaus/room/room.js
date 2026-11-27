// SHOWHAUS Room — ① scan a thing you own into a 3D object, ② place objects one at a time in a room photo, a floor plan
// or a tape-measured room, changing it by saying what to change. Every change is a step you can reopen.
import * as THREE from 'three';
import { buildRoom } from '../walk/plan-room.js';
import { bounds } from '../walk/plan-core.js';
import { parse, apply, describe, emptyState, clamp as clampN, WALL_COLOURS, PATTERNS } from './intent.js';
import { estimate, capture, buildMesh, LIGHT_HINT, priorForName, shapeOf, rangeOf, SURFACES } from './mesh.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search), src = qs.get('src') || qs.get('utm_source') || 'direct';
const track = (name, props = {}) => { try { window.SH && window.SH.track(name, { utm_source: src, ...props }); } catch { /* analytics never breaks the page */ } };
const toast = (t, ms = 2600) => { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), ms); };
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------- storage: objects + room photos in IndexedDB, the step list in localStorage
const db = new Promise((ok, no) => { const r = indexedDB.open('sh_room', 1); r.onupgradeneeded = () => { r.result.createObjectStore('objects', { keyPath: 'id' }); r.result.createObjectStore('blobs'); }; r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const idb = async (store, mode, fn) => { const d = await db; return new Promise((ok, no) => { const tx = d.transaction(store, mode), q = fn(tx.objectStore(store)); tx.oncomplete = () => ok(q && q.result); tx.onerror = () => no(tx.error); }); };
const lib = { all: () => idb('objects', 'readonly', s => s.getAll()), put: o => idb('objects', 'readwrite', s => s.put(o)) };
const blobs = { get: k => idb('blobs', 'readonly', s => s.get(k)), put: (k, v) => idb('blobs', 'readwrite', s => s.put(v, k)) };
let objects = [];
const objOf = id => objects.find(o => o.id === id);
async function refreshLib() { objects = (await lib.all()).sort((a, b) => a.created - b.created); $('libCount').textContent = objects.length; drawTray(); }

// ---------- mode switch
function mode(m) { document.body.dataset.mode = m; $('scan').hidden = m !== 'scan'; $('room').hidden = m !== 'room';
  $('tabScan').setAttribute('aria-selected', m === 'scan'); $('tabRoom').setAttribute('aria-selected', m === 'room'); if (m === 'room') openRoom(); }
$('tabScan').onclick = () => mode('scan'); $('tabRoom').onclick = () => mode('room');

// ================= ① SCAN =================
let A = null, vision = null, sel = null, scanT0 = 0; // A = analysed photo
const hud = $('hud'), hg = hud.getContext('2d');
const loadVision = () => vision || (vision = import('./vision.js'));
const fileToUrl = (f, max = 1024) => new Promise((ok, no) => { const im = new Image(); im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
  c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(im.src); ok(c.toDataURL('image/jpeg', 0.9)); }; im.onerror = no; im.src = typeof f === 'string' ? f : URL.createObjectURL(f); });

for (const id of ['cam', 'file']) $(id).onchange = e => e.target.files[0] && startScan(e.target.files[0], id);
$('sample').onclick = () => startScan('../walk/data/buildtec-avalon/photo2.jpg', 'sample');
addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/')); if (f && document.body.dataset.mode === 'scan') startScan(f, 'paste'); });
$('drop').addEventListener('dragover', e => e.preventDefault()); $('drop').addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (f) startScan(f, 'drop'); });

let phase = 'idle', band = 0;
async function startScan(f, how) {
  track('room_scan', { how }); scanT0 = performance.now();
  const url = await fileToUrl(f); $('photo').src = url; await $('photo').decode();
  $('drop').hidden = true; $('stage').hidden = false; $('sheet').hidden = true; sel = null; A = null; phase = 'loading'; sizeHud(); requestAnimationFrame(drawHud);
  try {
    const v = await loadVision();
    status('Loading vision models…');
    const dev = await v.load(b => status(`Loading vision models ${(b[0] / 1e6).toFixed(0)}${b[1] ? ' / ' + (b[1] / 1e6).toFixed(0) : ''} MB · the photo stays on this device`));
    status(`Scanning on this device (${dev === 'webgpu' ? 'GPU' : 'CPU'})…`); phase = 'scanning';
    A = await v.analyse(url); phase = 'reveal'; band = 0;
    track('room_detect', { n: A.boxes.length, ms: Math.round(performance.now() - scanT0), dev });
    status(A.boxes.length ? 'Tap the thing you want to keep. Not boxed? Tap it anyway.' : 'Nothing recognised. Tap the thing you want to keep.');
  } catch (e) { phase = 'error'; status('The scan could not run on this browser (' + (e.message || e) + '). Try Chrome or Safari, or another photo.'); track('room_scan_error', { msg: String(e.message || e).slice(0, 120) }); }
}
const status = t => { $('status').textContent = t; $('sheetHint').textContent = t; }; // the sheet covers the photo's status on phones, so it carries a copy
function sizeHud() { const im = $('photo'); hud.width = im.clientWidth * devicePixelRatio; hud.height = im.clientHeight * devicePixelRatio; }
new ResizeObserver(() => { if (!$('stage').hidden) sizeHud(); }).observe($('photo'));
let maskCanvas = null;
function drawHud(now) {
  if ($('stage').hidden) return;
  const W = hud.width, H = hud.height, im = $('photo'), sx = W / im.naturalWidth, sy = H / im.naturalHeight, t = now / 1000;
  hg.clearRect(0, 0, W, H);
  if (phase === 'loading' || phase === 'scanning') { // sweeping scan line over a measuring grid
    const y = ((t * (phase === 'scanning' ? 0.9 : 0.45)) % 1) * H, step = 22 * devicePixelRatio;
    hg.fillStyle = 'rgba(8,12,18,.35)'; hg.fillRect(0, 0, W, H);
    for (let gy = step / 2; gy < H; gy += step) for (let gx = step / 2; gx < W; gx += step) {
      const k = Math.max(0, 1 - Math.abs(gy - y) / (H * 0.18)); hg.fillStyle = `rgba(255,178,122,${0.12 + k * 0.8})`; hg.fillRect(gx, gy, 1.5 * devicePixelRatio, 1.5 * devicePixelRatio); }
    const gr = hg.createLinearGradient(0, y - 60, 0, y + 4); gr.addColorStop(0, 'rgba(255,140,80,0)'); gr.addColorStop(1, 'rgba(255,190,140,.55)'); hg.fillStyle = gr; hg.fillRect(0, y - 60, W, 64);
    hg.fillStyle = '#ffd2ad'; hg.fillRect(0, y, W, 2 * devicePixelRatio);
  }
  if (A && phase !== 'loading') {
    if (phase === 'reveal') { band = Math.min(1, band + 0.022); if (band >= 1) phase = 'ready'; }
    if (!A.depthCanvas) A.depthCanvas = depthImage(A);
    if (phase === 'reveal') { const by = band * H; hg.save(); hg.globalAlpha = 0.55; hg.beginPath(); hg.rect(0, Math.max(0, by - H * 0.25), W, Math.min(H * 0.25, by)); hg.clip(); hg.drawImage(A.depthCanvas, 0, 0, W, H); hg.restore(); }
    const shown = phase === 'reveal' ? band * H : H, tags = [], th = 17 * devicePixelRatio;
    hg.font = `600 ${12 * devicePixelRatio}px ui-monospace,monospace`;
    // tags never leave the photo and never sit on each other: clamp to the edges, then step down past any tag already placed
    const tagAt = (x0, y0, tw) => { let x = Math.min(Math.max(0, x0), W - tw), y = y0 - th - 1 * devicePixelRatio; if (y < 0) y = y0 + 1;
      for (let k = 0; k < 8 && tags.some(r => x < r.x + r.w && r.x < x + tw && y < r.y + th && r.y < y + th); k++) y += th + 2 * devicePixelRatio;
      tags.push({ x, y, w: tw }); return { x, y }; };
    A.boxes.forEach((b, i) => { const { xmin, ymin, xmax, ymax } = b.box; if (ymin * sy > shown) return;
      const x0 = xmin * sx, y0 = ymin * sy, x1 = xmax * sx, y1 = ymax * sy, L = Math.min(18 * devicePixelRatio, (x1 - x0) / 4, (y1 - y0) / 4), on = sel && sel.i === i;
      hg.strokeStyle = on ? '#ffb27a' : 'rgba(255,255,255,.85)'; hg.lineWidth = (on ? 3 : 2) * devicePixelRatio; hg.beginPath();
      for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) { hg.moveTo(cx + dx * L, cy); hg.lineTo(cx, cy); hg.lineTo(cx, cy + dy * L); }
      hg.stroke(); const tag = `${nice(b.label)} ${Math.round(b.score * 100)}%`;
      const tw = hg.measureText(tag).width + 10 * devicePixelRatio, p = tagAt(x0, y0, tw); hg.fillStyle = on ? '#ffb27a' : 'rgba(10,14,20,.78)'; hg.fillRect(p.x, p.y, tw, th);
      hg.fillStyle = on ? '#1a1206' : '#fff'; hg.fillText(tag, p.x + 5 * devicePixelRatio, p.y + th - 5 * devicePixelRatio); });
    if (maskCanvas) { hg.globalAlpha = 0.6 + 0.25 * Math.sin(t * 4); hg.drawImage(maskCanvas, 0, 0, W, H); hg.globalAlpha = 1; }
  }
  requestAnimationFrame(drawHud);
}
function depthImage(a) { const c = document.createElement('canvas'), W = a.img.width, H = a.img.height; c.width = W; c.height = H; const g = c.getContext('2d'), id = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { const v = a.depth[i] / 255; id.data[i * 4] = 255 * Math.min(1, v * 1.6); id.data[i * 4 + 1] = 120 + 110 * v; id.data[i * 4 + 2] = 255 * (1 - v) * 0.9 + 40; id.data[i * 4 + 3] = 200; }
  g.putImageData(id, 0, 0); return c; }
const NICE = { couch: 'Sofa', 'dining table': 'Table', 'potted plant': 'Plant', tv: 'TV', refrigerator: 'Fridge' };
const nice = l => NICE[l] || (l ? l[0].toUpperCase() + l.slice(1) : 'Item');

hud.addEventListener('click', async e => {
  if (!A || phase === 'loading' || phase === 'scanning') return;
  const r = hud.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * A.img.width, y = (e.clientY - r.top) / r.height * A.img.height;
  if (sel && !$('sheet').hidden) {
    // a tap on another detected thing (its box clear of the current cut-out) starts a new pick instead of adding to this one
    const ob = boxAt(x, y), inside = !!sel.mask[Math.round(y) * A.img.width + Math.round(x)];
    if (inside || !ob || ob.i === sel.i || boxShare(ob.b.box, sel.mask) > 0.3) return refine(x, y);
  }
  return pick(x, y);
});
const boxAt = (x, y) => A.boxes.map((b, i) => ({ b, i, a: (b.box.xmax - b.box.xmin) * (b.box.ymax - b.box.ymin) })).filter(({ b }) => x >= b.box.xmin && x <= b.box.xmax && y >= b.box.ymin && y <= b.box.ymax).sort((p, q) => p.a - q.a)[0];
function maskBox(mask) { const W = A.img.width, n = mask.length; let x0 = W, x1 = -1, y0 = 1e9, y1 = -1;
  for (let i = 0; i < n; i++) if (mask[i]) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { xmin: x0, ymin: y0, xmax: x1, ymax: y1 }; }
const boxArea = b => Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
// share of a detected box that the cut-out's own bounding box covers
function boxShare(box, mask) { const m = maskBox(mask); if (!m) return 0;
  const i = { xmin: Math.max(m.xmin, box.xmin), ymin: Math.max(m.ymin, box.ymin), xmax: Math.min(m.xmax, box.xmax), ymax: Math.min(m.ymax, box.ymax) };
  return boxArea(i) / (boxArea(box) || 1); }
// The name and typical size come from a detected box only when the cut-out really is that thing: their outlines
// must overlap well (IoU ≥ 0.5). A salad cut out inside the table's box is not a table, so it stays unnamed.
function labelFor(mask) { const m = maskBox(mask); if (!m) return { label: null, i: -1 }; let best = { label: null, i: -1, s: 0.5 };
  A.boxes.forEach((b, i) => { const k = { xmin: Math.max(m.xmin, b.box.xmin), ymin: Math.max(m.ymin, b.box.ymin), xmax: Math.min(m.xmax, b.box.xmax), ymax: Math.min(m.ymax, b.box.ymax) };
    const s = boxArea(k) / (boxArea(m) + boxArea(b.box) - boxArea(k) || 1); if (s >= best.s) best = { label: b.label, i, s }; });
  return best; }
async function pick(x, y) {
  status('Cutting it out…'); $('sheet').hidden = true; maskCanvas = null; sel = null;
  const v = await loadVision(), inBox = boxAt(x, y);
  // The tap says what the visitor means; SAM offers it at up to three sizes (salad → plate → table) and its own best is shown first.
  let r;
  try {
    r = await v.segment(A, [x, y], { object: true });
    if (!r.mask && inBox) { const b = inBox.b.box, rb = await v.segment(A, [b.xmin, b.ymin, b.xmax, b.ymax], { object: true });
      if (rb.mask && near(rb.mask, A.img.width, A.img.height, x, y, 8)) r = rb; }
  } catch (err) { status('Could not cut that out (' + (err.message || err).slice(0, 80) + '). Tap again.'); return; }
  if (!r.mask) { status('That looks like the wall, floor or ceiling. Tap the middle of the thing itself.'); track('room_segment_bg'); return; }
  const levels = (r.levels || []).filter(l => l.mask && capture(A, l.mask)); let lv = Math.max(0, levels.findIndex(l => l.mask === r.mask));
  // This is a furniture scanner: when one of the sizes is the detected thing under the finger (the sofa, not one cushion;
  // the fork, not the plate) start there. Smaller / Bigger reach the others (the salad on the table).
  if (inBox) { let best = 0; levels.forEach((l, k) => { const m = labelFor(l.mask); if (m.i === inBox.i && m.s > best) { best = m.s; lv = k; } }); }
  if (!levels.length) { status('Nothing to cut out there. Tap closer to the middle of the thing.'); return; }
  sel = { levels, lv, pts: r.pts, labels: r.labels, base: r.pts.length }; useLevel(lv);
  track('room_segment', { label: sel.label || 'tap', score: +sel.score.toFixed(2), levels: levels.length });
  openSheet();
  status(levels.length > 1 ? (SURFACES.has(sel.label) ? 'Just what’s on it? Smaller. All of it? Bigger.' : sel.label ? 'Just one part? Smaller. The whole thing? Bigger.' : 'Wrong size? Smaller / Bigger.') + ' Tap a missed part to add it, or another thing to pick that.' : 'Not right? Tap a missed part to add it, a wrong part to take it out, or another thing to pick that.');
}
function useLevel(k) { const l = sel.levels[k], m = labelFor(l.mask);
  Object.assign(sel, { lv: k, mask: l.mask, score: l.score, cap: capture(A, l.mask), label: m.label, i: m.i }); maskCanvas = maskImage(A, l.mask);
  $('lvSmaller').disabled = k === 0; $('lvBigger').disabled = k === sel.levels.length - 1; $('levels').hidden = sel.levels.length < 2; }
function stepLevel(d) { if (!sel || !sel.levels) return; const k = sel.lv + d; if (k < 0 || k >= sel.levels.length) return;
  // stepping size drops the visitor's own add/remove taps, they belonged to the old outline
  sel.pts = sel.pts.slice(0, sel.base); sel.labels = sel.labels.slice(0, sel.base); useLevel(k);
  if (!nameTyped) $('objName').value = sel.label ? nice(sel.label) : '';
  if (!measured) estimateDims(sel.label || priorForName($('objName').value)); else preview();
  track('room_level', { d, label: sel.label || 'tap' }); }
$('lvSmaller').onclick = () => stepLevel(-1); $('lvBigger').onclick = () => stepLevel(1);
// a tap while the cut-out is open steers it: outside the cut-out adds that spot, inside takes it out
async function refine(x, y) {
  const inside = !!sel.mask[Math.round(y) * A.img.width + Math.round(x)];
  status(inside ? 'Taking that part out…' : 'Adding that part…');
  // taking out a spot you added earlier just drops that point; otherwise add a positive or a negative point
  const near0 = inside ? sel.pts.findIndex((p, i) => sel.labels[i] === 1 && i >= sel.base && Math.hypot(p[0] - x, p[1] - y) < 24) : -1;
  const pts = near0 >= 0 ? sel.pts.filter((_, i) => i !== near0) : [...sel.pts, [Math.round(x), Math.round(y)]];
  const labels = near0 >= 0 ? sel.labels.filter((_, i) => i !== near0) : [...sel.labels, inside ? 0 : 1], v = await loadVision();
  let r; try { r = await v.segment(A, { pts, labels }, { object: true }); } catch (err) { status('Could not change the cut-out (' + String(err.message || err).slice(0, 80) + ').'); return; }
  // of SAM's sizes take the one closest to the current outline that obeys the tap (added spot in, removed spot out),
  // so steering a chosen size (the whole sofa) never jumps back to SAM's own favourite (one cushion)
  const W = A.img.width, at = Math.round(y) * W + Math.round(x), want = near0 >= 0 ? null : !inside;
  const fits = (r.levels || []).filter(l => l.mask && (want === null || !!l.mask[at] === want));
  const mask = fits.length ? fits.map(l => ({ m: l.mask, s: iouMask(l.mask, sel.mask) })).sort((p, q) => q.s - p.s)[0].m : r.mask;
  const cap = mask && capture(A, mask); if (!cap) { status('That would leave nothing. Tap somewhere else.'); return; }
  const lb = labelFor(mask); Object.assign(sel, { cap, mask, pts, labels, score: r.score }); if (lb.label) Object.assign(sel, { label: lb.label, i: lb.i }); maskCanvas = maskImage(A, mask);
  if (!nameTyped && sel.label) $('objName').value = nice(sel.label);
  if (!measured) estimateDims(sel.label || priorForName($('objName').value)); else preview();
  track('room_refine', { add: !inside, n: pts.length });
  status('Tap again to keep steering, or Keep it.');
}
const iouMask = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; } return i / (u || 1); };
const near = (m, W, H, x, y, r) => { for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) { const X = Math.round(x + dx), Y = Math.round(y + dy); if (X >= 0 && Y >= 0 && X < W && Y < H && m[Y * W + X]) return true; } return false; };
function maskImage(a, mask) { const W = a.img.width, H = a.img.height, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), id = g.createImageData(W, H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (!mask[i]) continue; const edge = !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W];
    id.data[i * 4] = 255; id.data[i * 4 + 1] = edge ? 220 : 160; id.data[i * 4 + 2] = edge ? 180 : 90; id.data[i * 4 + 3] = edge ? 255 : 70; }
  g.putImageData(id, 0, 0); return c; }

// sheet: name, size, 3D preview
let pv = null, dims = null, ratio = null, measured = false, nameTyped = false, rk = rangeOf(null);
const kindNow = () => sel && (sel.label || priorForName($('objName').value));
function openSheet() {
  measured = false; nameTyped = false; $('objName').value = sel.label ? nice(sel.label) : ''; $('objName').placeholder = 'What is it? e.g. coffee table';
  estimateDims(sel.label); $('sheet').hidden = false;
  if (!sel.label) $('objName').focus();
}
function estimateDims(label) {
  const est = estimate(label, ...sel.cap.px); dims = { w: est.w, h: est.h, d: est.d }; ratio = { ...dims }; rk = est.rk;
  $('dw').value = dims.w; $('dd').value = dims.d; $('dh').value = dims.h;
  $('dimNote').textContent = `Est. ${est.note} Type any real measurement and the others follow.`;
  $('isLight').checked = LIGHT_HINT.test(label || ''); status('');
  preview();
}
// a typed name with a typical size re-estimates the size until the visitor types a measurement
$('objName').addEventListener('input', e => { nameTyped = true; if (!sel || measured || sel.label) return; const k = priorForName(e.target.value); if (k) estimateDims(k); });
for (const k of ['w', 'd', 'h']) $('d' + k).addEventListener('input', e => { const v = parseFloat(e.target.value); if (!(v > 0)) return; const f = v / ratio[k];
  for (const o of ['w', 'd', 'h']) { dims[o] = +(ratio[o] * f).toFixed(2); if (o !== k) $('d' + o).value = dims[o]; } $('dimNote').textContent = 'Measured by you; the other two follow the photo.'; measured = true; preview(); });
$('isLight').onchange = preview;
function preview() {
  if (!pv) { const r = new THREE.WebGLRenderer({ canvas: $('preview'), antialias: true, alpha: true }); r.setPixelRatio(Math.min(2, devicePixelRatio)); r.toneMapping = THREE.ACESFilmicToneMapping;
    const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight('#fff', '#556', 2.2)); const dl = new THREE.DirectionalLight('#fff', 1.6); dl.position.set(2, 3, 3); sc.add(dl);
    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 50); pv = { r, sc, cam, obj: null }; const spin = t => { if (pv.obj) { pv.obj.rotation.y = Math.sin(t / 1400) * 0.9; } r.render(sc, cam); requestAnimationFrame(spin); }; requestAnimationFrame(spin); }
  // the canvas is stretched by CSS (full width × 110 px on a phone): draw at its real size and aspect, or a sofa comes out as a flat slab
  const cv = $('preview'), cw = cv.clientWidth || 300, ch = cv.clientHeight || 300; pv.r.setSize(cw, ch, false); pv.cam.aspect = cw / ch; pv.cam.updateProjectionMatrix();
  if (pv.obj) pv.sc.remove(pv.obj);
  const kind = kindNow(), shaped = !!shapeOf(kind), ghost = measured ? null : { w: dims.w * rk[1], d: dims.d * rk[1], h: dims.h * rk[1] };
  pv.obj = buildMesh(THREE, sel.cap, dims, { glow: $('isLight').checked, kind, ghost }); pv.sc.add(pv.obj);
  $('kindNote').textContent = (shaped ? `A ${nice(kind).toLowerCase()} shape at these sizes, in your photo’s colour.` : 'From one photo: front from its depth, back mirrored.')
    + (measured ? '' : ' Dashed box: the largest it could be.');
  const s = Math.max(ghost ? ghost.w : dims.w, ghost ? ghost.h : dims.h); const back = s * Math.max(1.75, 2.2 / Math.min(1.6, pv.cam.aspect)); pv.cam.position.set(s * 0.9, s * 0.85 + dims.h * 0.4, back); pv.cam.lookAt(0, dims.h * 0.4, 0); // three-quarter view from above: a seat reads as a seat
}
$('again').onclick = () => { $('sheet').hidden = true; maskCanvas = null; sel = null; status('Tap the thing you want to keep.'); };
$('objForm').onsubmit = async e => {
  e.preventDefault(); if (!sel) return;
  const o = { id: uid(), name: $('objName').value.trim() || nice(sel.label), label: sel.label, kind: kindNow() || null, light: $('isLight').checked, dims: { ...dims }, measured, created: Date.now(), ...sel.cap };
  await lib.put(o); await refreshLib(); track('room_keep', { label: o.label || 'tap', light: o.light });
  $('sheet').hidden = true; maskCanvas = null; sel = null;
  toast(`${o.name} kept. Scan another, or place it →`); status(`${objects.length} kept. Tap another thing, or go to ② Place it.`);
};

// ================= ② ROOM =================
let steps = [], cur = -1, R = null, three = null, plans = null, view = 'above';
const state = () => steps[cur]?.state;
const save = () => { try { localStorage.setItem('sh_room_steps', JSON.stringify({ steps: steps.slice(-80), cur: Math.min(cur, 79) })); } catch { /* full: the step list stays in memory */ } };
function restore() { try { const s = JSON.parse(localStorage.getItem('sh_room_steps') || 'null'); if (s && s.steps.length) { steps = s.steps; cur = s.cur; } } catch { /* start fresh */ } }

async function openRoom() {
  await refreshLib();
  if (!plans) { plans = await fetch('../arrange/plans/index.json').then(r => r.json()).then(j => j.items).catch(() => []);
    $('planList').innerHTML = plans.map(p => `<button type="button" data-slug="${p.slug}">${p.name}<small>${p.line}</small></button>`).join('') + '<button type="button" data-sample="1">Sample room photo<small>a dining room render</small></button>'; }
  if (cur < 0) restore();
  if (cur >= 0 && state().space) { await showSpace(); } else { $('spaces').hidden = false; $('view').hidden = true; }
  track('room_view', { objects: objects.length });
}
$('planList').onclick = async e => { const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.sample) { const url = await fileToUrl('../walk/data/buildtec-avalon/photo1.jpg', 1600); return setSpace({ kind: 'photo', title: 'Sample dining room', photo: await stash(url) }); }
  const p = plans.find(p => p.slug === b.dataset.slug); setSpace({ kind: 'plan', slug: p.slug, title: p.name }); };
$('tapeForm').onsubmit = e => { e.preventDefault(); const w = +$('tw').value, d = +$('td').value; if (w >= 1.5 && d >= 1.5) setSpace({ kind: 'tape', w, d, title: `${w} × ${d} m room` }); };
$('addrForm').onsubmit = e => { e.preventDefault(); const a = $('addr').value.trim(); if (!a) return; open('../p/go?q=' + encodeURIComponent(a), '_blank', 'noopener');
  setSpace({ kind: 'tape', w: +$('tw').value || 4.2, d: +$('td').value || 3.6, title: a }); toast('No plan on file for this address: measuring one room. Change the size with “width 4.5m room”.', 4200); };
$('roomPhoto').onchange = async e => { const f = e.target.files[0]; if (!f) return; const url = await fileToUrl(f, 1600); setSpace({ kind: 'photo', title: 'Your room photo', photo: await stash(url) }); };
$('newSpace').onclick = () => { $('spaces').hidden = false; $('view').hidden = true; };
async function stash(url) { const k = 'ph_' + uid(); await blobs.put(k, url); return k; }

function setSpace(space) {
  const keep = state()?.items || [];
  const op = { op: 'space', space, keepItems: true };
  push(op); // items survive a change of space; positions are re-fitted below
  const s = state(); if (keep.length) { const b = spaceBounds(s.space); s.items.forEach((it, k) => { it.x = Math.min(b[2] - 0.4, Math.max(b[0] + 0.4, (b[0] + b[2]) / 2 + (k - keep.length / 2) * 0.8)); it.y = (b[1] + b[3]) / 2; }); save(); }
  track('room_space', { kind: space.kind }); showSpace();
}
function planFor(space) {
  if (space.kind === 'plan') return space.plan;
  const w = space.w, d = space.d;
  return { outline: [[0, 0], [w, 0], [w, d], [0, d]], ceiling: { type: 'flat', h: 2.7 }, openings: [{ edge: 0, type: 'door', a: 0.4, b: 1.22 }, { edge: 2, type: 'window', a: w * 0.7, b: w * 0.3, sill: 0.9, head: 2.2, mullions: 1 }], finishes: {} };
}
const PHOTO_BOUNDS = [-2.6, 1.2, 2.6, 7];
function spaceBounds(sp) { return sp.kind === 'photo' ? PHOTO_BOUNDS : bounds(planFor(sp).outline); }

async function showSpace() {
  const s = state(); $('spaces').hidden = true; $('view').hidden = false;
  if (s.space.kind === 'plan' && !s.space.plan) s.space.plan = await fetch(`../arrange/plans/${s.space.slug}.json`).then(r => r.json());
  if (!three) initThree();
  const photo = s.space.kind === 'photo';
  $('host').classList.toggle('photo-mode', photo); $('horizonBtn').hidden = !photo; $('viewBtn').hidden = photo; $('horizon').hidden = true;
  if (photo) { $('roomImg').src = await blobs.get(s.space.photo); await $('roomImg').decode(); } else $('roomImg').removeAttribute('src');
  three.size(); sync(); drawTray(); drawTimeline();
}

function initThree() {
  const host = $('host'), renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.append(renderer.domElement);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(55, 1, 0.05, 300); cam.rotation.order = 'YXZ';
  const items = new THREE.Group(); scene.add(items);
  const photoRig = new THREE.Group(); scene.add(photoRig); // shadow catcher + lights for the photo space
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.35 })); catcher.receiveShadow = true; catcher.name = 'floor';
  const pHemi = new THREE.HemisphereLight('#fffaf0', '#8a8070', 1.7), pSun = new THREE.DirectionalLight('#fff3e0', 1.8); pSun.position.set(-3, 7, -2); pSun.target.position.set(0, 0, -3.5); pSun.castShadow = true;
  Object.assign(pSun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 30 }); pSun.shadow.mapSize.set(1024, 1024); pSun.shadow.radius = 4;
  photoRig.add(catcher, pHemi, pSun, pSun.target);
  three = { renderer, scene, cam, items, photoRig, catcher, pHemi, pSun, orbit: { th: -0.6, ph: 0.75, r: 9 }, eye: { yaw: 0, pitch: -0.1 }, nodes: new Map() };
  const size = () => { const ph = state()?.space.kind === 'photo', im = $('roomImg');
    let w = host.clientWidth, h = host.clientHeight;
    if (ph && im.naturalWidth) { const k = Math.min(w / im.naturalWidth, h / im.naturalHeight); w = Math.round(im.naturalWidth * k); h = Math.round(im.naturalHeight * k); }
    renderer.setSize(w, h); for (const el of [renderer.domElement, im, $('tint')]) Object.assign(el.style, { width: w + 'px', height: h + 'px', left: (host.clientWidth - w) / 2 + 'px', top: (host.clientHeight - h) / 2 + 'px' });
    cam.aspect = w / h; cam.fov = ph ? 2 * Math.atan(Math.tan(33 * Math.PI / 180) / cam.aspect) * 180 / Math.PI : (w < h ? 75 : 55); cam.updateProjectionMatrix(); three.w = w; three.h = h; };
  three.size = size; addEventListener('resize', () => { size(); drawTints(); });
  pointerInput(renderer.domElement);
  const frame = () => { if (!$('view').hidden) { place(); renderer.render(scene, cam); } requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}
function place() { // camera from the state
  const s = state(), { cam } = three; if (!s) return;
  if (s.space.kind === 'photo') { cam.position.set(0, 1.4, 0); cam.rotation.set(-s.horizon, 0, 0); return; }
  const b = spaceBounds(s.space), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  if (view === 'eye') { cam.position.set(cx, 1.55, -cy); cam.rotation.set(three.eye.pitch, three.eye.yaw, 0); return; }
  const o = three.orbit; cam.position.set(cx + o.r * Math.sin(o.ph) * Math.sin(o.th), o.r * Math.cos(o.ph), -cy + o.r * Math.sin(o.ph) * Math.cos(o.th)); cam.lookAt(cx, 0.5, -cy);
}

// state → scene (the renderer never changes on its own; only steps change it)
function sync() {
  const s = state(), t = three; if (!s || !t) return;
  const photo = s.space.kind === 'photo', key = JSON.stringify([s.space.kind, s.space.slug, s.space.w, s.space.d, s.floor]);
  if (t.spaceKey !== key) { if (R) t.scene.remove(R.root); R = null; t.spaceKey = key;
    if (!photo) { const plan = { ...planFor(s.space) }; plan.finishes = { ...(plan.finishes || {}), ...(s.floor ? { floor: s.floor } : {}) }; R = buildRoom(THREE, plan, { ceiling: false }); t.scene.add(R.root);
      R.walls.traverse(o => { if (o.isMesh) uvWall(o.geometry); }); R.wallMat = majority(R.walls); R.walls.scale.y = view === 'above' ? 0.45 : 1; t.orbit.r = Math.max(6, R.span * 1.45); }
    t.size(); }
  t.photoRig.visible = photo; t.scene.background = photo ? null : new THREE.Color(s.sun ? '#bcd3ea' : '#0e1420');
  // light
  const warm = new THREE.Color().setHSL(0.08 - s.warmth * 0.03, 0.15 + Math.max(0, s.warmth) * 0.6, 0.92), cool = new THREE.Color('#dfe8ff');
  const tint = s.warmth >= 0 ? warm : cool.lerp(warm, 1 + s.warmth);
  t.renderer.toneMappingExposure = s.exposure * (s.sun ? 1.05 : 0.8);
  if (photo) { t.pSun.intensity = s.sun ? 1.8 : 0; t.pHemi.intensity = s.sun ? 1.7 : 0.6; t.pSun.color = tint; t.pHemi.color = tint; t.catcher.material.opacity = s.sun ? 0.35 : 0.5;
    $('roomImg').style.filter = `brightness(${(s.sun ? 1 : 0.58) * s.exposure}) sepia(${Math.max(0, s.warmth) * 0.45}) hue-rotate(${Math.min(0, s.warmth) * 25}deg) saturate(${s.sun ? 1 : 0.7})`; }
  else R.root.traverse(o => { if (o.isDirectionalLight) { o.intensity = s.sun ? 1.6 : 0; o.color = tint; } if (o.isHemisphereLight) { o.intensity = s.sun ? 1.9 : 0.6; o.color = tint; } });
  if (R) applyWall(s.wall);
  // items
  const seen = new Set();
  for (const it of s.items) { const obj = objOf(it.obj); if (!obj) continue; seen.add(it.uid);
    let n = t.nodes.get(it.uid);
    const dk = JSON.stringify(it.dims) + it.light;
    if (!n || n.dk !== dk) { if (n) t.items.remove(n.g); const g = buildMesh(THREE, obj, it.dims, { glow: it.light }) /* no dashed largest-size box here: it belongs to the scan sheet, not the room picture */; const L = new THREE.PointLight('#ffd6a0', 0, 7, 1.6); L.position.set(0, it.dims.h * 0.92, 0.1); g.add(L);
      n = { g, L, dk }; t.nodes.set(it.uid, n); t.items.add(g); }
    n.g.position.set(it.x, 0, -it.y); n.g.rotation.y = it.r * Math.PI / 180; n.g.scale.setScalar(it.k);
    n.L.intensity = it.light && it.on ? (s.sun ? 3 : 9) : 0;
    n.g.traverse(o => { if (o.isMesh) { o.material.emissiveIntensity = it.light && it.on ? 1 : 0; o.material.emissive = new THREE.Color(it.uid === selUid ? '#6b3a1c' : it.light && it.on ? '#ffd9a0' : '#000'); if (it.uid === selUid) o.material.emissiveIntensity = Math.max(o.material.emissiveIntensity, 0.22); } });
  }
  for (const [k, n] of t.nodes) if (!seen.has(k)) { t.items.remove(n.g); t.nodes.delete(k); }
  drawTints(); drawSel();
}
function majority(group) { const c = new Map(); group.traverse(o => { if (o.isMesh) c.set(o.material, (c.get(o.material) || 0) + 1); }); return [...c].sort((a, b) => b[1] - a[1])[0][0]; }
function uvWall(g) { const p = g.attributes.position, uv = []; for (let i = 0; i < p.count; i++) uv.push((p.getX(i) - p.getZ(i)) / 1.2, p.getY(i) / 1.2); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); }
const patCache = new Map();
function pattern(name, colour) { const k = name + colour; if (patCache.has(k)) return patCache.get(k);
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'), base = new THREE.Color(colour), dark = '#' + base.clone().multiplyScalar(0.82).getHexString(), lite = '#' + base.clone().lerp(new THREE.Color('#fff'), 0.35).getHexString();
  g.fillStyle = colour; g.fillRect(0, 0, 256, 256);
  if (name === 'stripes') { g.fillStyle = dark; for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 26, 256); }
  if (name === 'check') { g.fillStyle = dark; g.globalAlpha = 0.5; for (let x = 0; x < 256; x += 64) { g.fillRect(x, 0, 18, 256); g.fillRect(0, x, 256, 18); } }
  if (name === 'dots') { g.fillStyle = lite; for (let y = 0; y < 256; y += 32) for (let x = (y / 32 % 2) * 16; x < 256; x += 32) { g.beginPath(); g.arc(x + 8, y + 8, 5, 0, 7); g.fill(); } }
  if (name === 'panel') { g.strokeStyle = dark; g.lineWidth = 6; for (let x = 0; x < 256; x += 128) g.strokeRect(x + 14, 150, 100, 90); g.fillStyle = dark; g.fillRect(0, 128, 256, 8); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; patCache.set(k, t); return t; }
function applyWall(w) { const m = R.wallMat, col = WALL_COLOURS[w.colour] || '#f1eee8';
  if (w.pattern && w.pattern !== 'plain') { m.map = pattern(w.pattern, col); m.color.set('#ffffff'); } else { m.map = null; m.color.set(col); } m.needsUpdate = true; }

// photo-space wall repaint: SAM on the room photo, tint multiplied over the wall's own shading
let roomA = null; const tintMasks = new Map();
async function roomAnalysis() { if (roomA && roomA.url === $('roomImg').src) return roomA; const v = await loadVision(); toast('Reading the room photo…', 9000);
  await v.load(b => toast(`Loading vision models ${(b[0] / 1e6).toFixed(0)}${b[1] ? ' / ' + (b[1] / 1e6).toFixed(0) : ''} MB`, 9000)); roomA = await v.analyse($('roomImg').src); return roomA; }
async function tintMask(u, v) { const k = u.toFixed(3) + ',' + v.toFixed(3); if (tintMasks.has(k)) return tintMasks.get(k);
  const a = await roomAnalysis(), vis = await loadVision(), { mask } = await vis.segment(a, [u * a.img.width, v * a.img.height]); const m = { mask, W: a.img.width, H: a.img.height }; tintMasks.set(k, m); return m; }
let tintKey = '';
async function drawTints() {
  const s = state(), c = $('tint'); if (!s || s.space.kind !== 'photo') { c.width = 0; tintKey = ''; return; }
  const key = $('roomImg').src.length + JSON.stringify(s.tints); if (key === tintKey) return; tintKey = key;
  const im = $('roomImg'), W = im.naturalWidth, H = im.naturalHeight; c.width = W; c.height = H; const g = c.getContext('2d');
  for (const t of s.tints) { const m = await tintMask(t.u, t.v); const id = g.getImageData(0, 0, W, H), col = new THREE.Color(WALL_COLOURS[t.colour] || t.colour);
    const sx = m.W / W, sy = m.H / H; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!m.mask[Math.floor(y * sy) * m.W + Math.floor(x * sx)]) continue; const i = (y * W + x) * 4;
      id.data[i] = col.r * 255; id.data[i + 1] = col.g * 255; id.data[i + 2] = col.b * 255; id.data[i + 3] = 255; } g.putImageData(id, 0, 0); }
}

// ---------- pointer: drag an object on the floor; drag elsewhere turns the view; tap a wall for paint
let selUid = null;
function pointerInput(cv) {
  const ray = new THREE.Raycaster(), ptrs = new Map(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag = null, down = null, pinch = 0;
  const ndc = e => { const b = cv.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1); };
  const floorAt = e => { ray.setFromCamera(ndc(e), three.cam); const p = new THREE.Vector3(); return ray.ray.intersectPlane(plane, p) ? [p.x, -p.z] : null; };
  const itemAt = e => { ray.setFromCamera(ndc(e), three.cam); const h = ray.intersectObjects(three.items.children, true)[0]; if (!h) return null; for (const [k, n] of three.nodes) { let o = h.object; while (o) { if (o === n.g) return k; o = o.parent; } } return null; };
  cv.addEventListener('pointerdown', e => { ptrs.set(e.pointerId, [e.clientX, e.clientY]); try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
    const k = itemAt(e); down = { x: e.clientX, y: e.clientY, k, moved: 0 };
    if (k) { const it = state().items.find(i => i.uid === k), f = floorAt(e); drag = { k, off: f ? [it.x - f[0], it.y - f[1]] : [0, 0], x: it.x, y: it.y }; selUid = k; sync(); } });
  cv.addEventListener('pointermove', e => { const p = ptrs.get(e.pointerId); if (!p) return; const dx = e.clientX - p[0], dy = e.clientY - p[1]; ptrs.set(e.pointerId, [e.clientX, e.clientY]); if (down) down.moved += Math.abs(dx) + Math.abs(dy);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) three.orbit.r = Math.min(40, Math.max(2.5, three.orbit.r * pinch / d)); pinch = d; return; }
    if (drag) { const f = floorAt(e); if (f) { const it = state().items.find(i => i.uid === drag.k), b = spaceBounds(state().space); it.x = clampN(f[0] + drag.off[0], b[0] + 0.1, b[2] - 0.1); it.y = clampN(f[1] + drag.off[1], b[1] + 0.1, b[3] - 0.1); sync(); } return; }
    if (state().space.kind === 'photo') return;
    if (view === 'eye') { three.eye.yaw += dx * 0.005; three.eye.pitch = clampN(three.eye.pitch + dy * 0.004, -1, 0.6); } else { three.orbit.th -= dx * 0.008; three.orbit.ph = clampN(three.orbit.ph - dy * 0.006, 0.12, 1.45); } });
  const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = 0;
    if (drag) { const it = state().items.find(i => i.uid === drag.k); if (Math.hypot(it.x - drag.x, it.y - drag.y) > 0.02) { const x = it.x, y = it.y; it.x = drag.x; it.y = drag.y; push({ op: 'move', uid: drag.k, x: +x.toFixed(3), y: +y.toFixed(3) }); } drag = null; }
    else if (down && down.moved < 8) tap(e);
    down = null; drawSel(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); drag = null; down = null; });
  cv.addEventListener('wheel', e => { e.preventDefault(); three.orbit.r = clampN(three.orbit.r * (1 + Math.sign(e.deltaY) * 0.1), 2.5, 40); }, { passive: false });
  function tap(e) {
    if (down.k) return; selUid = null;
    const s = state(), b = cv.getBoundingClientRect();
    if (s.space.kind === 'photo') { swatches({ u: (e.clientX - b.left) / b.width, v: (e.clientY - b.top) / b.height }); sync(); return; }
    ray.setFromCamera(ndc(e), three.cam); const h = ray.intersectObjects(R ? [R.walls] : [], true)[0];
    if (h && h.object.material === R.wallMat) swatches(null); else $('swatches').hidden = true;
    sync();
  }
}
function swatches(at) { const el = $('swatches'); el.hidden = false;
  el.innerHTML = `<b>${at ? 'Repaint this wall' : 'Walls'}</b>` + Object.entries(WALL_COLOURS).map(([k, c]) => `<button data-c="${k}" style="--c:${c}" aria-label="${k}"></button>`).join('') +
    (at ? '' : PATTERNS.map(p => `<button data-p="${p}" class="pat">${p}</button>`).join('')) + '<button class="x" aria-label="Close">✕</button>';
  el.onclick = e => { const t = e.target.closest('button'); if (!t) return; if (t.classList.contains('x')) { el.hidden = true; return; }
    if (at && t.dataset.c) { push({ op: 'wallTint', u: +at.u.toFixed(3), v: +at.v.toFixed(3), colour: t.dataset.c }); el.hidden = true; return; }
    push({ op: 'wall', ...(t.dataset.c ? { colour: t.dataset.c } : { pattern: t.dataset.p }) }); }; }

// ---------- steps
function push(op) {
  if (op.op === 'undo') { if (cur > 0) { cur--; afterStep(); toast('Back one step'); } return; }
  const prev = state() || emptyState(), next = apply(prev, op);
  if (cur < steps.length - 1) toast(`Branched from step ${cur + 1}: the later steps were replaced`);
  steps = steps.slice(0, cur + 1); steps.push({ op, label: describe(op, nameOf), state: next }); cur = steps.length - 1; afterStep();
}
const nameOf = u => (state()?.items.find(i => i.uid === u) || steps.flatMap(s => s.state.items).find(i => i.uid === u) || {}).name || 'item';
function afterStep() { save(); sync(); drawTimeline(); }
function drawTimeline() { const el = $('timeline');
  el.innerHTML = steps.map((s, k) => `<li><button data-k="${k}" class="${k === cur ? 'cur' : k > cur ? 'future' : ''}"><i>${k + 1}</i>${s.label}</button></li>`).join('');
  el.querySelector('.cur')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }
$('timeline').onclick = e => { const b = e.target.closest('button'); if (!b) return; const k = +b.dataset.k; if (k === cur) return;
  cur = k; $('heard').textContent = ''; track('room_rewind', { to: k, of: steps.length }); save(); showSpace(); };

// ---------- tray: place kept objects one at a time
function drawTray() { const el = $('tray'); if (!el) return; const on = new Set((state()?.items || []).map(i => i.obj));
  el.innerHTML = objects.length ? objects.map(o => `<button data-id="${o.id}" class="${on.has(o.id) ? 'in' : ''}" title="Place ${o.name}"><img src="${o.thumb}" alt=""><span>${o.name}</span></button>`).join('') + '<button class="add" data-scan="1">+ Scan</button>'
    : '<button class="add wide" data-scan="1">Nothing kept yet: ① scan a thing you own first</button>'; }
$('tray').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.scan) return mode('scan');
  const o = objOf(b.dataset.id), s = state(), bd = spaceBounds(s.space);
  let x = (bd[0] + bd[2]) / 2, y = s.space.kind === 'photo' ? 3.2 : (bd[1] + bd[3]) / 2;
  for (let n = 0; n < 8 && s.items.some(i => Math.hypot(i.x - x, i.y - y) < 0.6); n++) x += 0.7 * (n % 2 ? -n : n);
  const u = uid(); push({ op: 'add', uid: u, obj: o.id, name: o.name, label: o.label, light: o.light, dims: o.dims, x: +clampN(x, bd[0] + 0.3, bd[2] - 0.3).toFixed(3), y: +y.toFixed(3) });
  selUid = u; sync(); drawTray(); track('room_place', { n: s.items.length + 1, kind: s.space.kind }); };

// ---------- selected object bar
function drawSel() { const it = state()?.items.find(i => i.uid === selUid); $('selbar').hidden = !it; if (!it) return;
  $('selName').textContent = `${it.name} · ${(it.dims.w * it.k).toFixed(2)} × ${(it.dims.d * it.k).toFixed(2)} × ${(it.dims.h * it.k).toFixed(2)} m${objOf(it.obj)?.measured && it.k === 1 ? '' : ' est.'}`; $('lightBtn').textContent = it.light ? (it.on ? 'Light off' : 'Light on') : 'Glow'; $('lightBtn').title = it.light ? '' : 'Make it a light'; }
$('selbar').onclick = e => { const a = e.target.closest('button')?.dataset.a, it = state().items.find(i => i.uid === selUid); if (!a || !it) return;
  const ops = { rotL: { op: 'rotate', uid: it.uid, by: 15 }, rotR: { op: 'rotate', uid: it.uid, by: -15 }, smaller: { op: 'scale', uid: it.uid, by: 1 / 1.05 }, bigger: { op: 'scale', uid: it.uid, by: 1.05 },
    light: { op: 'light', uid: it.uid, on: !(it.light && it.on), make: true }, remove: { op: 'remove', uid: it.uid } };
  push(ops[a]); if (a === 'remove') { selUid = null; drawTray(); } };

// ---------- say what to change
$('say').onsubmit = e => { e.preventDefault(); const text = $('sayIn').value.trim(); if (!text) return; run(text); $('sayIn').value = ''; };
$('quick').onclick = e => { const b = e.target.closest('button'); if (b?.dataset.say) run(b.dataset.say); };
function run(text) {
  const s = state(), { ops } = parse(text, { items: s.items, selected: selUid });
  track('room_say', { n: ops.length, len: text.length });
  if (!ops.length) { $('heard').textContent = `Didn’t catch a change in “${text}”. Try: “${s.items[0]?.name || 'sofa'} 50cm left”, “turn it 45°”, “walls navy”, “floor tile”, “night”.`; return; }
  const done = [], photo = s.space.kind === 'photo';
  if (photo && ops.some(o => o.op === 'wall' || o.op === 'floor')) toast('In a photo, tap the wall itself to repaint it.', 3600);
  for (const op of ops.filter(o => !(photo && (o.op === 'wall' || o.op === 'floor')))) { const abs = resolve(op); if (abs) { push(abs); done.push(steps[cur].label); } }
  $('heard').textContent = done.length ? '✓ ' + done.join(' · ') : '';
}
// relative ops → absolute ones, using the camera you are looking through
function resolve(op) {
  const s = state(), it = s.items.find(i => i.uid === op.uid), b = spaceBounds(s.space);
  if (op.op === 'nudge') { if (!it) return null; const d = new THREE.Vector3(); three.cam.getWorldDirection(d); const fwd = [d.x, -d.z], L = Math.hypot(...fwd) || 1, f = [fwd[0] / L, fwd[1] / L], r = [f[1], -f[0]];
    const v = { left: [-r[0], -r[1]], right: r, away: f, near: [-f[0], -f[1]] }[op.dir];
    return { op: 'move', uid: it.uid, x: +clampN(it.x + v[0] * op.m, b[0] + 0.1, b[2] - 0.1).toFixed(3), y: +clampN(it.y + v[1] * op.m, b[1] + 0.1, b[3] - 0.1).toFixed(3) }; }
  if (op.op === 'center') return it && { op: 'move', uid: it.uid, x: +((b[0] + b[2]) / 2).toFixed(3), y: +((b[1] + b[3]) / 2).toFixed(3) };
  if (op.op === 'toWall') { if (!it) return null; const dd = it.dims.d * it.k / 2 + 0.02, opts = [[b[0] + dd, it.y, 90, it.x - b[0]], [b[2] - dd, it.y, 270, b[2] - it.x], [it.x, b[1] + dd, 0, it.y - b[1]], [it.x, b[3] - dd, 180, b[3] - it.y]];
    const w = opts.sort((p, q) => p[3] - q[3])[0]; push({ op: 'setRot', uid: it.uid, r: w[2] }); return { op: 'move', uid: it.uid, x: +w[0].toFixed(3), y: +w[1].toFixed(3) }; }
  return op;
}

// ---------- view toggles
$('viewBtn').onclick = () => { view = view === 'above' ? 'eye' : 'above'; $('viewBtn').textContent = view === 'above' ? 'Eye level' : 'From above'; if (R) R.walls.scale.y = view === 'above' ? 0.45 : 1; track('room_view_toggle', { view }); };
$('horizonBtn').onclick = () => { $('horizon').hidden = !$('horizon').hidden; $('horizon').value = state().horizon; };
$('horizon').oninput = e => { state().horizon = +e.target.value; };
$('horizon').onchange = e => { const v = +e.target.value; state().horizon = steps[cur - 1]?.state.horizon ?? 0.12; push({ op: 'horizon', v }); };

// test hook for the click-through judge
window.__room = { state: () => ({ steps: steps.length, cur, objects: objects.length, items: state()?.items.map(({ uid, name, x, y, r, k, on, light }) => ({ uid, name, x, y, r, k, on, light })), space: state()?.space?.kind, wall: state()?.wall, sun: state()?.sun }),
  run, push, mode, select: u => { selUid = u; sync(); }, phase: () => phase, boxes: () => A && A.boxes.map(b => ({ label: b.label, score: b.score, box: b.box })), size: () => A && [A.img.width, A.img.height], sel: () => sel && { label: sel.label, px: sel.cap.px } };

refreshLib().then(() => { if (qs.get('m') === 'room' || location.hash === '#room') mode('room'); });
