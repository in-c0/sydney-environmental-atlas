// SHOWHAUS Studio email kit: records the walkthrough with headless Chromium and writes
//   dist/showhaus/studio/<slug>/{walkthrough.gif, walkthrough.mp4, poster.png, still-sunrise.png, still-winter-3pm.png, still-top-floor-view.png, kit.json}
// Usage: node scripts/showhaus-studio-kit.mjs <slug> [--date YYYY-MM-DD]
// Needs: playwright (chromium) and ffmpeg on PATH. Frames are seeked deterministically (window.studio.seek), not screen-recorded.
import { createServer } from 'node:http';
import { readFile, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const slug = (process.argv[2] || 'arncliffe-central').replace(/[^a-z0-9-]/g, '');
const dateArg = process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const OUT = join(ROOT, 'showhaus/studio', slug);
const FR = join(tmpdir(), `showhaus-kit-${slug}`);
const W = 1280, H = 800, FPS = 12, GIF_FPS = 8, SECONDS = 5, GIF_W = 600, GIF_MAX = 1.8 * 1024 * 1024;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif' };

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) { res.writeHead(204); return res.end(); }
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/showhaus/studio/`;

const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}?p=${slug}&kit=1&clean=1&date=${dateArg}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.studio && window.studio.map && window.studio.map.loaded() && window.studio.keyframes().length > 0, null, { timeout: 90000 });
const settle = () => page.evaluate(() => new Promise(r => { const m = window.studio.map; let done = false; const fin = () => { if (!done) { done = true; r(); } }; m.once('idle', fin); m.triggerRepaint(); setTimeout(fin, 6000); }));

await rm(FR, { recursive: true, force: true }); await mkdir(FR, { recursive: true }); await mkdir(OUT, { recursive: true });
const loop = await page.evaluate(() => window.studio.loopLen());
const N = FPS * SECONDS;
for (let i = 0; i < N; i++) {
  // the 5-second loop is the whole walkthrough, time-lapsed (loop / 5 × real time)
  await page.evaluate(t => window.studio.seek(t), (i / N) * loop);
  await settle();
  await page.screenshot({ path: join(FR, `f${String(i).padStart(3, '0')}.png`) });
  if (i % 10 === 0) console.log(`frame ${i}/${N}`);
}

// stills
const still = async (name, fn) => { await page.evaluate(fn); await settle(); await page.waitForTimeout(300); await settle(); await page.screenshot({ path: join(OUT, name) }); };
await page.evaluate(() => window.studio.seek(0)); await settle(); await page.screenshot({ path: join(OUT, 'poster.png') });
await still('still-sunrise.png', () => { window.studio.setDay('today'); window.studio.seek(4); window.studio.setClock(window.studio.sun().rise + 20); });
await still('still-winter-3pm.png', () => { window.studio.setDay('06-21'); window.studio.seek(9); window.studio.setClock(15 * 60); });
const top = await page.evaluate(() => {
  window.studio.setDay('today');
  const k = window.studio.keyframes().find(x => x.eye); window.studio.seek(k.t); window.studio.setClock(15 * 60);
  return { tower: k.eye[0], level: k.eye[1], aspect: k.eye[2], target: k.eye[3] };
});
await settle(); await page.waitForTimeout(300); await settle();
await page.screenshot({ path: join(OUT, 'still-top-floor-view.png') });

// encode
const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
ff('-framerate', String(FPS), '-i', join(FR, 'f%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', join(OUT, 'walkthrough.mp4'));
let gifW = GIF_W, colors = 96, size = Infinity;
for (let attempt = 0; attempt < 6 && size > GIF_MAX; attempt++) {
  const pal = join(FR, 'pal.png');
  ff('-framerate', String(FPS), '-i', join(FR, 'f%03d.png'), '-vf', `fps=${GIF_FPS},scale=${gifW}:-1:flags=lanczos,palettegen=max_colors=${colors}:stats_mode=full`, pal);
  ff('-framerate', String(FPS), '-i', join(FR, 'f%03d.png'), '-i', pal, '-lavfi', `fps=${GIF_FPS},scale=${gifW}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0', join(OUT, 'walkthrough.gif'));
  size = (await stat(join(OUT, 'walkthrough.gif'))).size;
  console.log(`gif ${gifW}px ${colors} colours → ${(size / 1048576).toFixed(2)} MB`);
  if (size > GIF_MAX) { colors = Math.max(32, colors - 32); if (colors === 32) gifW = Math.max(560, gifW - 20); }
}
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', join(OUT, 'walkthrough.gif')]).toString());
const mp4 = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', join(OUT, 'walkthrough.mp4')]).toString());
const kit = {
  slug, recorded: new Date().toISOString(), date: dateArg, viewport: [W, H], fps: FPS, frames: N, walkthrough_seconds: loop, timelapse: +(loop / SECONDS).toFixed(1),
  gif: { width: probe.streams[0].width, height: probe.streams[0].height, bytes: size, duration_s: Number(probe.format.duration) },
  mp4: { bytes: Number(mp4.format.size), duration_s: Number(mp4.format.duration) },
  stills: { sunrise: 'still-sunrise.png', winter_3pm: 'still-winter-3pm.png', top_floor_view: 'still-top-floor-view.png', top_floor: top },
  label: 'Massing model from public planning documents · sun position: NOAA · surrounding buildings: OpenStreetMap. Not photoreal.',
  console_errors: errors.length
};
await writeFile(join(OUT, 'kit.json'), JSON.stringify(kit, null, 1));
console.log(JSON.stringify(kit, null, 1));
await browser.close(); server.close();
await rm(FR, { recursive: true, force: true });
if (errors.length) { console.error('console errors:', errors.slice(0, 5)); process.exitCode = 1; }
