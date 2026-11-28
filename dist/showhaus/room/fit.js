// SHOWHAUS Room: does the selected thing fit where it stands? One line a mover can act on.
// Pure: plan (walk/plan-core plan), room items ({ uid, name, x, y, r°, k, dims }), the selected uid.
import { rectInRoom, clearances, overlaps } from '../walk/plan-core.js';

const WALK = 0.6; // narrower than this between a thing and a wall or another thing, nobody walks through comfortably

// axis-aligned footprint of a thing turned by any angle
export function footprint(it) {
  const a = (it.r || 0) * Math.PI / 180, w = it.dims.w * (it.k || 1), d = it.dims.d * (it.k || 1);
  const W = Math.abs(w * Math.cos(a)) + Math.abs(d * Math.sin(a)), D = Math.abs(w * Math.sin(a)) + Math.abs(d * Math.cos(a));
  return { t: 'box', id: it.uid, x: it.x, y: it.y, r: 0, w: W, d: D, rc: [it.x - W / 2, it.y - D / 2, it.x + W / 2, it.y + D / 2] };
}

const cm = v => v < 1 ? `${Math.round(v * 100)} cm` : `${v.toFixed(2)} m`;

/** The verdict a mover can trust: checked at the guessed size AND at the largest the unmeasured sides could be.
 *  worst = { w, d } multipliers for the sides nobody measured (1 = measured). → { tone, text, unsure? } */
export function fitVerdict(plan, items, uid, worst = { w: 1, d: 1 }) {
  const guess = fitLine(plan, items, uid); if (!guess || guess.tone === 'no' || (worst.w <= 1 && worst.d <= 1)) return guess;
  const it = items.find(i => i.uid === uid), grow = t => ({ w: it.dims.w * (1 + (worst.w - 1) * t), d: it.dims.d * (1 + (worst.d - 1) * t) });
  const fits = t => fitLine(plan, items.map(i => i === it ? { ...i, dims: { ...i.dims, ...grow(t) } } : i), uid).tone !== 'no';
  if (fits(1)) return guess;
  // the largest unmeasured size that still fits: the one number to hold a tape against
  let lo = 0, hi = 1; for (let n = 0; n < 16; n++) { const t = (lo + hi) / 2; if (fits(t)) lo = t; else hi = t; }
  const g = grow(lo), k = it.k || 1, side = worst.w > 1 && worst.d > 1 ? 'width and depth' : worst.w > 1 ? 'width' : 'depth';
  const limit = side === 'width' ? `its width is under ${cm(g.w * k)}` : side === 'depth' ? `its depth is under ${cm(g.d * k)}` : `it is under ${cm(g.w * k)} × ${cm(g.d * k)}`;
  return { tone: 'tight', unsure: side, limit: g, text: `Fits if ${limit}. Measure its ${side}` };
}

/** → { tone: 'ok' | 'tight' | 'no', text } */
export function fitLine(plan, items, uid) {
  const it = items.find(i => i.uid === uid); if (!it) return null;
  const me = footprint(it), others = items.filter(i => i !== it).map(footprint);
  if (!rectInRoom(plan, me.rc)) return { tone: 'no', text: 'Doesn’t fit here: it runs into a wall' };
  const hit = items.filter(i => i !== it).find(o => overlaps(me.rc, footprint(o).rc));
  if (hit) return { tone: 'no', text: `Overlaps the ${hit.name.toLowerCase()}` };
  const gaps = Object.values(clearances(plan, others, me)).filter(v => v != null);
  const narrow = gaps.filter(v => v > 0.05 && v < WALK).sort((a, b) => a - b)[0];
  if (narrow != null) return { tone: 'tight', gap: narrow, text: `Fits, tight: ${cm(narrow)} to walk past` };
  const open = gaps.filter(v => v > 0.05); // against a wall (≈0) is a choice, not a squeeze
  return { tone: 'ok', gap: open.length ? Math.min(...open) : null, text: open.length ? `Fits · ${cm(Math.min(...open))} clear on the tightest side` : 'Fits' };
}
