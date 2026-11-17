// Publish walk-pipeline plans to the arrange page: showhaus/walk-pipeline/plans/<slug>.plan.json → dist/showhaus/arrange/plans/<slug>.json
// + index.json. No bake: the browser builds the room from the plan itself. Run after adding or changing a plan:
//   node scripts/showhaus-arrange-plans.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
// Which plans the arrange page lists, in order. Fixtures are invented and say so in their name.
export const PUBLISH = ['buildtec-erina', 'buildtec-avalon', 'fixture-apartment', 'fixture-studio'];
const KEEP = ['slug', 'name', 'by', 'type', 'rooms', 'source', 'source_url', 'page_url', 'assumptions', 'outline', 'ceiling', 'openings', 'outdoor', 'finishes', 'items', 'views', 'walls', 'spaces', 'wall_t'];
export function publishable(p) { return Object.fromEntries(KEEP.filter(k => p[k] !== undefined).map(k => [k, p[k]])); }
export function indexRow(p) {
  const xs = p.outline.map(q => q[0]), ys = p.outline.map(q => q[1]);
  const size = `${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} × ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} m`;
  return { slug: p.slug, name: p.name, line: [p.rooms, size].filter(Boolean).join(' · '), source: p.source, outline: p.outline, walls: p.walls || [] };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = root + 'dist/showhaus/arrange/plans/'; mkdirSync(out, { recursive: true });
  const rows = PUBLISH.map(slug => {
    const p = JSON.parse(readFileSync(root + `showhaus/walk-pipeline/plans/${slug}.plan.json`, 'utf8'));
    writeFileSync(out + slug + '.json', JSON.stringify(publishable(p)) + '\n');
    return indexRow(p);
  });
  writeFileSync(out + 'index.json', JSON.stringify({ items: rows }, null, 1) + '\n');
  console.log('published', rows.map(r => r.slug).join(', '));
}
