// Outside judge for SHOWHAUS listing kits (dist/showhaus/p/<slug>.json + media).
// For every kit: the page loads at 1440×900 and 390×844 with no scroll or overflow and zero console errors; the facts
// appear in < 2.5 s on an emulated phone (slow 4G, 4× CPU); every number on the page is recounted from its source file;
// "known" sun hours are re-checked against the honesty rule; the GIF is 5.0 ± 0.3 s, ≤ 1.8 MB, ≥ 480 px wide.
// Usage: node scripts/showhaus-kit-judge.mjs [--shots dir] [--only slug]
// Needs: npm i --no-save playwright && npx playwright install chromium
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const K = require('../dist/showhaus/lib/kit.js');
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const P = join(ROOT, 'showhaus/p');
const arg = n => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const shots = arg('--shots'), only = arg('--only');
if (shots) await mkdir(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// ---------- independent recounts (own code, not the page's) ----------
const rents = JSON.parse(await readFile(join(ROOT, 'showhaus/data/rents.json'), 'utf8'));
function rentMedian(postcode, type) {
  const pi = rents.postcodes.indexOf(Number(postcode)); const v = [];
  for (let i = 0; i < rents.w.length; i++) if (rents.pc[i] === pi && (type == null || rents.t[i] === type)) v.push(rents.w[i]);
  v.sort((a, b) => a - b);
  if (!v.length) return { n: 0, m: null };
  const pos = (v.length - 1) / 2, lo = Math.floor(pos), hi = Math.ceil(pos);
  return { n: v.length, m: Math.round(v[lo] + (v[hi] - v[lo]) * (pos - lo)) };
}
function metres(a, b) { const n = (b[1] - a[1]) * 111320, e = (b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180); return Math.hypot(n, e); }
function segDist(p, a, b) {
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 111320;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(ax + t * vx, ay + t * vy);
}
function mainRoad(kit) {
  const p = [kit.geocode.lng, kit.geocode.lat]; let best = Infinity;
  for (const l of kit.roads.lines) if (['motorway', 'trunk', 'primary'].includes(l.cls)) for (let i = 1; i < l.pts.length; i++) best = Math.min(best, segDist(p, l.pts[i - 1], l.pts[i]));
  return Number.isFinite(best) ? Math.round(best) : null;
}
// GIF: logical screen width and the sum of frame delays (graphic control extensions), read from the bytes.
function gifInfo(buf) {
  if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
  const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8);
  let i = 13, frames = 0, cs = 0;
  if (buf[10] & 0x80) i += 3 * (1 << ((buf[10] & 7) + 1));
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x3b) break;
    if (b === 0x21) {
      if (buf[i + 1] === 0xf9) cs += buf.readUInt16LE(i + 4);
      i += 2; while (buf[i]) i += buf[i] + 1; i++;
    } else if (b === 0x2c) {
      frames++; const packed = buf[i + 9]; i += 10;
      if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));
      i++; while (buf[i]) i += buf[i] + 1; i++;
    } else break;
  }
  return { width, height, frames, seconds: cs / 100 };
}

// ---------- server (static dist + a stand-in for the Worker's /api/e) ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4' };
const events = [];
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/e') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { events.push(JSON.parse(b)); } catch { /* bad body */ } res.writeHead(204); res.end(); }); return; }
  try {
    let p = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/showhaus/p/`;

const slugs = (await readdir(P)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(s => !only || s === only).sort();
check('at least one kit exists', slugs.length > 0, slugs.join(', '));

const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

for (const slug of slugs) {
  const kit = JSON.parse(await readFile(join(P, slug + '.json'), 'utf8'));
  console.log(`\n# ${slug} — ${kit.address}`);
  // Media
  for (const f of ['walkthrough.gif', 'walkthrough.mp4', 'poster.png', 'scene.png']) {
    const s = await stat(join(P, slug, f)).catch(() => null);
    check(`${slug}: ${f} exists`, !!s && s.size > 1000, s ? `${(s.size / 1024).toFixed(0)} KB` : 'missing');
  }
  const gbuf = await readFile(join(P, slug, 'walkthrough.gif')).catch(() => null);
  const g = gbuf && gifInfo(gbuf);
  check(`${slug}: GIF lasts 5.0 ± 0.3 s`, !!g && Math.abs(g.seconds - 5) <= 0.3, g ? `${g.seconds} s, ${g.frames} frames` : 'unreadable');
  check(`${slug}: GIF ≤ 1.8 MB and ≥ 480 px wide`, !!g && gbuf.length <= 1.8 * 1048576 && g.width >= 480, g ? `${(gbuf.length / 1048576).toFixed(2)} MB, ${g.width}×${g.height}` : '');

  // Honesty rule for sun, from the raw building list: "known" only if every building within 30 m of the ground points has a mapped height.
  const pts = kit.ground.points;
  const near = kit.buildings.features.filter(b => b.ring.some(v => pts.some(p => metres(p, v) <= 30)));

  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push(e.message.slice(0, 160)));
    const phone = w < 500;
    if (phone) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    const before = events.length;
    const t0 = Date.now();
    await page.goto(`${base}?a=${slug}&src=agent-${slug}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => /ready/.test(document.body.dataset.state), null, { timeout: 30000 }).catch(() => {});
    const factsMs = Date.now() - t0;
    const label = `${slug} @${w}×${h}`;
    if (phone) check(`${label}: facts on screen < 2.5 s (slow 4G, 4× CPU)`, factsMs < 2500, `${factsMs} ms`);
    await page.waitForFunction(() => window.__kit?.ready === true, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const doc = document.scrollingElement, panel = document.querySelector('.panel');
      const out = [];
      for (const el of document.querySelectorAll('.fact, .rent, .foot > *, .sweep, h1')) {
        const b = el.getBoundingClientRect(); if (!b.width) continue;
        if (b.left < -1 || b.top < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1) out.push(el.dataset.k || el.className || el.tagName);
      }
      const v = {}; document.querySelectorAll('[data-k]').forEach(el => { v[el.dataset.k] = { v: el.dataset.v, n: el.dataset.n, day: el.dataset.day }; });
      return { scroll: doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1, panelOverflow: panel.scrollHeight > panel.clientHeight + 1, out, v, text: document.body.innerText, state: document.body.dataset.state, canvas: !!document.querySelector('#map canvas') };
    });
    check(`${label}: one screen — no scroll, nothing cut off`, !r.scroll && !r.panelOverflow && !r.out.length, r.out.join(', ') + (r.panelOverflow ? ' panel overflows' : ''));
    check(`${label}: 3D map rendered`, r.canvas && r.state === 'ready', r.state);
    check(`${label}: zero console errors`, !errors.length, errors.slice(0, 3).join(' | '));
    check(`${label}: shows the address`, r.text.includes(kit.address));
    if (shots) await page.screenshot({ path: join(shots, `${slug}-${w}x${h}.png`) });

    if (!phone) {
      // Recount every number shown.
      for (const key of ['sun-today', 'sun-winter']) {
        const x = r.v[key]; const s = x && K.groundSun(kit, x.day);
        const honest = s && (s.known ? near.length > 0 && near.every(b => b.src !== 'est') : true);
        check(`${slug}: ${key} recounted (${x?.day})`, !!s && String(s.known ? s.minutes : 'unknown') === x.v && honest, `page ${x?.v}, recount ${s?.known ? s.minutes : 'unknown'}${s?.known ? '' : ' — ' + s?.why}`);
      }
      const main = mainRoad(kit);
      check(`${slug}: main-road distance recounted`, String(main ?? '>2500') === r.v['road-main']?.v, `page ${r.v['road-main']?.v} m, recount ${main} m`);
      const c = kit.canopy.rows[0];
      check(`${slug}: canopy equals the NSW answer`, String(c ? Math.round(c.Canopy_pc * 100) : 'unknown') === r.v.canopy?.v, `page ${r.v.canopy?.v}, source ${c?.Canopy_pc}`);
      const pc = kit.rent?.postcode;
      for (const [key, type] of [['rent-all', null], ['rent-units', 0], ['rent-houses', 1]]) {
        const x = rentMedian(pc, type), shown = r.v[key];
        const want = x.n >= 10 ? String(x.m) : 'few';
        check(`${slug}: ${key} recounted from rents.json`, shown?.v === want && Number(shown?.n) === x.n, `page ${shown?.v} (n=${shown?.n}), recount ${want} (n=${x.n})`);
      }
      const z = kit.planning.zoning.rows[0];
      check(`${slug}: zoning equals the NSW answer`, z ? r.v.zoning?.v?.startsWith(z.SYM_CODE + ' ') : r.v.zoning?.v === 'no LEP zone mapped', r.v.zoning?.v);
      check(`${slug}: Sydney Airport ANEF shown as unknown (not connected)`, r.v.aircraft?.v === 'unknown');
      await page.waitForTimeout(300);
      const got = events.slice(before).find(e => e.e === 'view' && e.a === slug);
      check(`${slug}: view event sent with src, nothing else`, !!got && got.src === `agent-${slug}` && Object.keys(got).sort().join() === 'a,e,src', JSON.stringify(got));
    }
    await ctx.close();
  }
}

// A link to a kit that does not exist says so instead of a blank page.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}?a=no-such-kit`);
  await page.waitForFunction(() => document.body.dataset.state === 'error', null, { timeout: 10000 }).catch(() => {});
  check('unknown slug: says the property is not on SHOWHAUS', /not \(or no longer\) on SHOWHAUS/.test(await page.innerText('body')));
  await page.close();
}

await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
