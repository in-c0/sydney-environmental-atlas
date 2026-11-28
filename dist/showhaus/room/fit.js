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

/** → { tone: 'ok' | 'tight' | 'no', text } */
export function fitLine(plan, items, uid) {
  const it = items.find(i => i.uid === uid); if (!it) return null;
  const me = footprint(it), others = items.filter(i => i !== it).map(footprint);
  if (!rectInRoom(plan, me.rc)) return { tone: 'no', text: 'Doesn’t fit here: it runs into a wall' };
  const hit = items.filter(i => i !== it).find(o => overlaps(me.rc, footprint(o).rc));
  if (hit) return { tone: 'no', text: `Overlaps the ${hit.name.toLowerCase()}` };
  const gaps = Object.values(clearances(plan, others, me)).filter(v => v != null);
  const narrow = gaps.filter(v => v > 0.05 && v < WALK).sort((a, b) => a - b)[0];
  if (narrow != null) return { tone: 'tight', text: `Fits, tight: ${cm(narrow)} to walk past` };
  const open = gaps.filter(v => v > 0.05); // against a wall (≈0) is a choice, not a squeeze
  return { tone: 'ok', text: open.length ? `Fits · ${cm(Math.min(...open))} clear on the tightest side` : 'Fits' };
}
