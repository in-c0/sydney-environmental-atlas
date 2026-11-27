// SHOWHAUS Room: open-weight vision models that run in the visitor's browser (transformers.js, ONNX on WASM or WebGPU).
// Nothing leaves the device: the photo is read here and the weights come from the Hugging Face hub once, then the cache.
//   detect  Xenova/detr-resnet-50 (COCO boxes)        segment  Xenova/slimsam-77-uniform (box or tap → mask)
//   depth   onnx-community/depth-anything-v2-small (relative depth, near = bright)
const TF = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';
const MODELS = { detect: 'Xenova/detr-resnet-50', sam: 'Xenova/slimsam-77-uniform', depth: 'onnx-community/depth-anything-v2-small' };
let T, det, depthP, sam, samProc;
const progress = {}; // file → {loaded,total}
export const bytes = () => Object.values(progress).reduce((a, p) => [a[0] + (p.loaded || 0), a[1] + (p.total || 0)], [0, 0]);
const cb = onP => e => { if (e.file && (e.status === 'progress' || e.status === 'done')) { progress[e.name + '/' + e.file] = { loaded: e.loaded ?? e.total, total: e.total }; onP && onP(bytes()); } };

async function tf() { if (!T) { T = await import(TF); T.env.allowLocalModels = false; } return T; }
const device = async () => ('gpu' in navigator && (await navigator.gpu.requestAdapter().catch(() => null))) ? 'webgpu' : 'wasm';

export async function load(onP) {
  const t = await tf(), dev = await device(), opt = { device: dev, dtype: dev === 'webgpu' ? 'fp32' : 'q8', progress_callback: cb(onP) };
  [det, depthP, sam, samProc] = await Promise.all([
    det || t.pipeline('object-detection', MODELS.detect, opt),
    depthP || t.pipeline('depth-estimation', MODELS.depth, { ...opt, dtype: dev === 'webgpu' ? 'fp16' : 'q8' }),
    sam || t.SamModel.from_pretrained(MODELS.sam, opt),
    samProc || t.AutoProcessor.from_pretrained(MODELS.sam, { progress_callback: cb(onP) }),
  ]);
  return dev;
}

// One photo → { img (RawImage), boxes, depth (Uint8 W×H, near = 255), embed } ready for taps.
export async function analyse(url) {
  const t = await tf(), img = await t.RawImage.read(url);
  const [boxes, d, inputs] = await Promise.all([det(img, { threshold: 0.55, percentage: false }), depthP(img), samProc(img)]);
  const embed = await sam.get_image_embeddings(inputs);
  const dep = d.depth.width === img.width ? d.depth : await d.depth.resize(img.width, img.height);
  return { img, url, boxes: dedupe(boxes), depth: dep.data, embed, inputs };
}
const iou = (a, b) => { const x0 = Math.max(a.xmin, b.xmin), y0 = Math.max(a.ymin, b.ymin), x1 = Math.min(a.xmax, b.xmax), y1 = Math.min(a.ymax, b.ymax);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0), A = r => (r.xmax - r.xmin) * (r.ymax - r.ymin); return i / (A(a) + A(b) - i || 1); };
// one thing, one box: a weaker box of the same label that overlaps a kept one or sits mostly inside it is the same thing
const inside = (a, b) => { const x0 = Math.max(a.xmin, b.xmin), y0 = Math.max(a.ymin, b.ymin), x1 = Math.min(a.xmax, b.xmax), y1 = Math.min(a.ymax, b.ymax);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / (((b.xmax - b.xmin) * (b.ymax - b.ymin)) || 1); };
function dedupe(boxes) { const out = []; for (const b of boxes.sort((p, q) => q.score - p.score))
  if (!out.some(o => iou(o.box, b.box) > 0.7 || (o.label === b.label && inside(o.box, b.box) > 0.6))) out.push(b); return out.slice(0, 12); }

// Prompt SAM with a box [x0,y0,x1,y1] or a point [x,y] (original pixels) → best mask as Uint8 W×H (1 = object).
export async function segment(a, prompt, opts = {}) {
  // This SAM export takes points only. A box becomes points: positives where the photo is nearest inside the box
  // (the object usually stands in front of what is behind it), negatives just outside its four sides.
  // prompt: a box [x0,y0,x1,y1], a tap [x,y], or { pts, labels } (the visitor's own add/remove taps)
  const [pts, labels] = prompt.pts ? [prompt.pts, prompt.labels] : prompt.length === 4 ? boxPoints(a, prompt) : [[prompt], [1]];
  const p = { input_points: [[pts]], input_labels: [[labels]] };
  const inp = await samProc(a.img, p);
  const out = await sam({ ...a.embed, input_points: inp.input_points, input_labels: inp.input_labels });
  const masks = await samProc.post_process_masks(out.pred_masks, inp.original_sizes, inp.reshaped_input_sizes);
  const sc = out.iou_scores.data, m = masks[0], W = a.img.width, H = a.img.height, n = W * H;
  // SAM gives three masks from fine to coarse. For a thing (opts.object) a mask that fills a big part of the photo or
  // runs along three edges is the wall, floor or ceiling, not the thing: take the best-scoring one that is neither.
  const stats = [0, 1, 2].map(k => { let area = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let i = 0; i < n; i++) if (m.data[k * n + i]) { area++; const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const edges = (y0 === 0) + (y1 === H - 1) + (x0 === 0) + (x1 === W - 1), span = Math.max((x1 - x0) / W, (y1 - y0) / H);
    return { k, score: sc[k], frac: area / n, edges, span }; });
  const box = prompt.length === 4 || !!prompt.pts; // a box or the visitor's own points already say where the thing is; a bare tap gets the strict test
  const things = stats.filter(t => t.frac > 0.002 && (box ? t.frac < 0.85 : t.frac < 0.3 && t.edges < 3 && t.span < 0.75)).sort((p, q) => q.score - p.score);
  const pickK = opts.object ? (things[0] ? things[0].k : -1) : stats.sort((p, q) => q.score - p.score)[0].k;
  if (pickK < 0) return { mask: null, background: true, levels: [] };
  const toMask = k => { const mk = new Uint8Array(n); for (let i = 0; i < n; i++) mk[i] = m.data[k * n + i] ? 1 : 0; return mk; };
  // every usable level, small to large (salad → plate → table), so the visitor can step between them
  const levels = (opts.object ? things : stats).slice().sort((p, q) => p.frac - q.frac)
    .filter((t, i, a) => i === 0 || t.k === pickK || t.frac > a[i - 1].frac * 1.15)
    .map(t => ({ k: t.k, score: t.score, frac: t.frac, mask: t.k === pickK ? null : toMask(t.k) }));
  const mask = toMask(pickK); for (const l of levels) if (l.k === pickK) l.mask = mask;
  if (!levels.some(l => l.k === pickK)) levels.push({ k: pickK, score: sc[pickK], mask });
  return { mask, score: sc[pickK], pts, labels, levels, pick: levels.findIndex(l => l.k === pickK) };
}

function boxPoints(a, [x0, y0, x1, y1]) {
  const W = a.img.width, H = a.img.height, w = x1 - x0, h = y1 - y0, cand = [];
  for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) { const x = Math.round(x0 + w * (0.2 + 0.6 * i / 6)), y = Math.round(y0 + h * (0.2 + 0.6 * j / 6)); cand.push([x, y, a.depth[y * W + x]]); }
  cand.sort((p, q) => q[2] - p[2]);
  const pos = []; for (const c of cand) { if (pos.every(p => Math.hypot(p[0] - c[0], p[1] - c[1]) > Math.max(w, h) * 0.22)) pos.push(c); if (pos.length === 3) break; }
  const cl = (v, m) => Math.max(0, Math.min(m - 1, Math.round(v)));
  const neg = [[(x0 + x1) / 2, y0 - h * 0.06], [(x0 + x1) / 2, y1 + h * 0.06], [x0 - w * 0.06, (y0 + y1) / 2], [x1 + w * 0.06, (y0 + y1) / 2]]
    .filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => [cl(x, W), cl(y, H)]);
  return [[...pos.map(p => [p[0], p[1]]), ...neg], [...pos.map(() => 1), ...neg.map(() => 0)]];
}
