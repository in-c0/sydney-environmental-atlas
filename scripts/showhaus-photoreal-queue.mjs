// SHOWHAUS photoreal render queue: the walk card promises visitors that homes with the most votes are made photoreal
// first. This turns the Worker's `queue.photoreal` (live walks by net votes, private homes already removed) into the
// next render job, so the GPU step can only ever take homes in that order.
//
//   node scripts/showhaus-photoreal-queue.mjs plan <walk-queue.json>            → the lane, each home done / next / waiting / skipped
//   node scripts/showhaus-photoreal-queue.mjs job  <walk-queue.json> [out.json]  → manifest for the first home not yet photoreal
//
// <walk-queue.json> is the snapshot CVF's showhaus-walk-queue workflow writes (farm-state state/showhaus/walk-queue.json),
// or a saved /api/ops/summary response. A home is "done" when a view in its room.js carries a photo. No votes → no job:
// nothing is rendered ahead of what visitors asked for.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALK = join(ROOT, 'dist/showhaus/walk/data');
const PLANS = join(ROOT, 'showhaus/walk-pipeline/plans');

export function readRoom(slug, dir = WALK) {
  const f = join(dir, slug, 'room.js');
  if (!existsSync(f)) return null;
  const s = readFileSync(f, 'utf8'); const i = s.indexOf('{');
  try { return JSON.parse(s.slice(i, s.lastIndexOf('}') + 1)); } catch { return null; }
}

export function lane(queue, { rooms = readRoom, gallery } = {}) {
  const q = queue && (queue.photoreal ? queue : queue.queue) || {};
  const live = new Set((gallery || JSON.parse(readFileSync(join(WALK, 'index.json'), 'utf8')).items).filter(i => i.kind === 'walk').map(i => i.slug));
  let next = null;
  const rows = (q.photoreal || []).map(({ slug, votes }) => {
    if (!live.has(slug)) return { slug, votes, state: 'skipped', why: 'not a live walk in the gallery' };
    const room = rooms(slug);
    if (!room) return { slug, votes, state: 'skipped', why: 'no room.js' };
    const views = room.views || [];
    const todo = views.filter(v => !v.photo).map(v => v.name);
    if (views.some(v => v.photo)) return { slug, votes, state: 'done', photos: views.filter(v => v.photo).length };
    const row = { slug, votes, state: next ? 'waiting' : 'next', views: todo };
    if (!next) next = row;
    return row;
  });
  return { rows, next };
}

export function job(next, at = new Date().toISOString()) {
  if (!next) return null;
  const plan = join('showhaus/walk-pipeline/plans', `${next.slug}.plan.json`);
  return {
    slug: next.slug, votes: next.votes, at,
    plan: existsSync(join(ROOT, plan)) ? plan : null,
    views: next.views,
    steps: [
      'walkgen.py <plan> preview → proxy renders per view (exact geometry)',
      'photoreal still per view, conditioned on the proxy render (plan-to-walkthrough §1.3)',
      'photoreal walk clip on a rented GPU (plan-to-walkthrough §4): self-terminate timer first, record wall time + peak VRAM',
      'fresh critic yes/no, then add photo/clip to the views in room.js and PR',
    ],
  };
}

function main([cmd, file, out]) {
  if (!cmd || !file) { console.error('usage: plan|job <walk-queue.json> [out.json]'); process.exit(2); }
  const { rows, next } = lane(JSON.parse(readFileSync(file, 'utf8')));
  if (cmd === 'plan') {
    if (!rows.length) console.log('photoreal lane is empty (no votes yet): nothing to render');
    for (const r of rows) console.log([r.state.padEnd(7), String(r.votes).padStart(3), r.slug, r.why || (r.views ? r.views.join(', ') : `${r.photos} photo views`)].join('  '));
    return;
  }
  if (cmd === 'job') {
    const j = job(next);
    if (!j) { console.log('no job: every voted home is done, or nobody has voted'); return; }
    if (out) writeFileSync(out, JSON.stringify(j, null, 2) + '\n');
    console.log(JSON.stringify(j, null, 2));
    return;
  }
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
