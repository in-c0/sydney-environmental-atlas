// Outside judge for SHOWHAUS Studio: walkthrough page, portfolio embed, pilot page and email kit.
// Serves dist/ locally (plus stand-ins for the Worker routes), drives headless Chromium at 1440×900, 1280×720, 390×844.
// Recounts from the recorded data with its own code (not studio-core.js). Usage: node scripts/showhaus-studio-judge.mjs [--shots dir]
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const SLUG = 'arncliffe-central';
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shotsDir) await mkdir(shotsDir, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4' };
const events = [];
let config = { payment: false, contact: null };
const HOSTS = {
  'plain.html': `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plain</title></head><body style="margin:0;font:16px sans-serif">
    <h1 style="margin:16px">Our projects</h1><p style="margin:16px;height:1400px">Scroll down for the walkthrough.</p>
    <div style="padding:0 16px"><script src="/showhaus/studio/embed.js" data-project="${SLUG}" async></script></div><p style="height:200px"></p></body></html>`,
  'agency.html': `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agency</title>
    <style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Georgia,serif;color:#222}header,footer{background:#111;color:#eee;padding:18px 24px}
    .wrap{max-width:1200px;margin:0 auto;padding:24px;display:grid;grid-template-columns:2fr 1fr;gap:32px}aside{background:#f4f4f4;padding:16px}
    .hero{height:520px;background:linear-gradient(#ccc,#999);margin-bottom:24px}@media(max-width:800px){.wrap{grid-template-columns:1fr;padding:16px}}</style></head>
    <body><header>Harbour &amp; Co Project Marketing</header><div class="wrap"><main><div class="hero"></div><h2>Arncliffe — explore the outlook</h2>
    <p>Copy about the project. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p><p style="height:500px"></p>
    <script src="/showhaus/studio/embed.js" data-project="${SLUG}" async></script><p>More copy after the embed.</p></main>
    <aside><h3>Register interest</h3><p>Form goes here.</p></aside></div><footer>© Agency</footer></body></html>`
};
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/e') { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { events.push(JSON.parse(b)); } catch { /* ignore */ } res.writeHead(204); res.end(); }); return; }
  if (u.pathname === '/api/studio-config') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(config)); }
  if (u.pathname === '/pay/studio-pilot') { events.push({ e: 'checkout_start', server: true, src: u.searchParams.get('src') }); res.writeHead(302, { location: config.payment ? 'https://buy.stripe.com/judge-test' : '/showhaus/studio/pilot.html?reserve=1#reserve' }); return res.end(); }
  if (u.pathname.startsWith('/host/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HOSTS[u.pathname.slice(6)] || 'nope'); }
  try {
    let p = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}/showhaus/studio/`;

const data = JSON.parse(await readFile(join(ROOT, `showhaus/studio/data/${SLUG}.json`), 'utf8'));
const source = JSON.parse(await readFile(join(REPO, `showhaus/studio/${SLUG}.source.json`), 'utf8'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// ---------- 1. the massing against the documents (before anything else) ----------
const rad = Math.PI / 180, R = 6371008.8;
const lat0 = data.site.boundary[0][1], kx = rad * R * Math.cos(lat0 * rad), ky = rad * R;
const xy = p => [p[0] * kx, p[1] * ky];
const area = ring => { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, y1] = xy(ring[i]), [x2, y2] = xy(ring[(i + 1) % ring.length]); a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; };
const inRing = (p, ring) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) ins = !ins; } return ins; };
const distToRing = (p, ring) => { const P = xy(p); let best = Infinity; for (let i = 0; i < ring.length - 1; i++) { const A = xy(ring[i]), B = xy(ring[i + 1]); const dx = B[0] - A[0], dy = B[1] - A[1]; const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (dx * dx + dy * dy))); best = Math.min(best, Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy)); } return best; };
const consent = { A: [101.0, 22], B: [101.3, 23], C: [96.1, 19], D: [93.6, 21] };          // MOD-10 consolidated consent: max RL, levels in the drawing list
const report2022 = { A: [70, 91.65], B: [71.5, 94.9], C: [67.4, 92.65], D: [60.6, 91.2] };  // 2022 assessment report: height m, RL
check('site area matches the assessment report (13,440.3 m²) within 1 %', Math.abs(area(data.site.boundary) - 13440.3) / 13440.3 < 0.01, `${area(data.site.boundary).toFixed(0)} m²`);
for (const t of data.towers) {
  const [rl, lv] = consent[t.id], [h22, rl22] = report2022[t.id];
  check(`Building ${t.id}: max RL ${t.max_rl_ahd_m} = consent RL ${rl}`, t.max_rl_ahd_m === rl);
  check(`Building ${t.id}: ${t.levels} levels = consent drawing list (${lv})`, t.levels === lv);
  check(`Building ${t.id}: height ${t.height_m_est} m = RL − (2022 RL − 2022 height)`, Math.abs(t.height_m_est - (rl - (rl22 - h22))) < 0.01);
  check(`Building ${t.id}: floors fit under the approved max height`, t.levels * t.floor_to_floor_m_est <= t.height_m_est + 0.01, `${(t.levels * t.floor_to_floor_m_est).toFixed(1)} ≤ ${t.height_m_est}`);
  const a = area(t.footprint);
  check(`Building ${t.id}: footprint ${a.toFixed(0)} m² is a plausible tower floor plate (700–1,400 m²)`, a > 700 && a < 1400);
  const outside = t.footprint.filter(p => !inRing(p, data.site.boundary) && distToRing(p, data.site.boundary) > 2.5);
  check(`Building ${t.id}: footprint inside the site boundary (±2.5 m)`, outside.length === 0, outside.length ? `${outside.length} vertices outside` : '');
  check(`Building ${t.id}: figures equal the recorded source file`, JSON.stringify(t.footprint) === JSON.stringify(source.towers.find(x => x.id === t.id).footprint) && t.max_rl_ahd_m === source.towers.find(x => x.id === t.id).max_rl_ahd_m);
}

// ---------- independent sun recount (own ray caster) ----------
function sunPos(lat, lng, day, mins) {
  // NOAA, written out again here on purpose (independent of lib/core.js)
  const [y, m, d] = day.split('-').map(Number);
  const off = new Date(`${day}T12:00:00Z`).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/);
  const tz = off ? Number(off[1]) : 10;
  const jd = (Date.UTC(y, m - 1, d, 0, mins) - tz * 3600000) / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360, M = 357.52911 + T * (35999.05029 - 0.0001537 * T), e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
  const om = 125.04 - 1934.136 * T, lam = L0 + C - 0.00569 - 0.00478 * Math.sin(om * rad);
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(om * rad);
  const dec = Math.asin(Math.sin(eps * rad) * Math.sin(lam * rad)), yy = Math.tan(eps * rad / 2) ** 2;
  const eq = 4 / rad * (yy * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * yy * Math.sin(M * rad) * Math.cos(2 * L0 * rad) - 0.5 * yy * yy * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
  const ha = (((mins + eq + 4 * lng - 60 * tz) % 1440 + 1440) % 1440) / 4 - 180;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha * rad)) / rad;
  const az = (Math.atan2(Math.sin(ha * rad), Math.cos(ha * rad) * Math.sin(lat * rad) - Math.tan(dec) * Math.cos(lat * rad)) / rad + 540) % 360;
  return { el, az };
}
function recountSun(tower, level, aspect, day) {
  const pts = data.towers.flatMap(t => t.footprint), lon0 = pts.reduce((s, p) => s + p[0], 0) / pts.length, la0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const kx2 = rad * R * Math.cos(la0 * rad), L = p => [(p[0] - lon0) * kx2, (p[1] - la0) * ky];
  const t = data.towers.find(x => x.id === tower), P = L(t.facade_points[aspect]), z = level * t.floor_to_floor_m_est + 1.6, faz = t.aspects[aspect];
  const obs = [...data.context_buildings.features.map(b => ({ h: b.h, r: b.r.map(L) })), ...data.towers.filter(x => x.id !== tower).map(x => ({ h: x.height_m_est, r: x.footprint.map(L) }))];
  let sun = 0;
  for (let mm = 0; mm < 1440; mm += 10) {
    const s = sunPos(la0, lon0, day, mm);
    if (s.el <= 3 || Math.abs(((s.az - faz) % 360 + 540) % 360 - 180) >= 90) continue;
    const dx = Math.sin(s.az * rad), dy = Math.cos(s.az * rad), tn = Math.tan(s.el * rad);
    let blocked = false;
    for (const o of obs) {
      if (o.h <= z) continue;
      // march along the ray instead of solving intersections: a different method on purpose
      for (let d = 1; d < 700 && !blocked; d += 1.5) { if (z + d * tn >= o.h) break; if (inRing([P[0] + dx * d, P[1] + dy * d], o.r)) blocked = true; }
      if (blocked) break;
    }
    if (blocked) continue;
    if (z + Math.max(0, data.context_buildings.radius_m - Math.hypot(...P)) * tn < 30) continue;
    sun += 10;
  }
  return sun;
}

// ---------- 2. the walkthrough page ----------
const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const VIEWPORTS = [[1440, 900], [1280, 720], [390, 844]];
const ignorable = t => /tiles\.openfreemap|net::ERR|Failed to load resource|GPU stall|GL Driver/.test(t);
async function open(url, [w, h], opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...opts });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !ignorable(m.text())) errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page, errors };
}
const overflow = page => page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
const allNumbers = new Set();
(function walk(v) { if (v == null) return; if (typeof v === 'number') { allNumbers.add(String(v)); allNumbers.add(String(Math.round(v))); } else if (typeof v === 'string') (v.match(/\d+(?:\.\d+)?/g) || []).forEach(n => allNumbers.add(n)); else if (typeof v === 'object') Object.values(v).forEach(walk); })(data);

for (const vp of VIEWPORTS) {
  const tag = `studio ${vp[0]}×${vp[1]}`;
  const before = events.length;
  const { ctx, page, errors } = await open(`${base}?p=${SLUG}&src=judge`, vp);
  await page.waitForFunction(() => window.studio?.keyframes?.().length > 0, null, { timeout: 90000 });
  await page.waitForTimeout(2500);
  check(`${tag} walkthrough plays on load`, await page.evaluate(() => document.body.dataset.state === 'playing' && window.studio.state.playing));
  const o = await overflow(page);
  check(`${tag} one screen, no scroll / overflow`, o.x <= 0 && o.y <= 0, JSON.stringify(o));
  // tap pauses
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width * .3, box.y + box.height * .55);
  await page.waitForTimeout(400);
  check(`${tag} tap pauses the walkthrough`, await page.evaluate(() => document.body.dataset.state === 'paused'));
  // key controls are inside the viewport
  const vis = await page.evaluate(() => ['#playBtn', '#clock', '#lift button', '.tabs', '#selTitle'].map(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && r.width > 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.top >= -1; }));
  check(`${tag} controls (play, time, levels, tabs, title) on screen`, vis.every(Boolean), JSON.stringify(vis));
  // floor change → event + massing highlight
  await page.locator('#lift button').nth(5).click();
  await page.waitForTimeout(500);
  const sel = await page.evaluate(() => ({ l: window.studio.state.level, b: window.studio.state.tower }));
  check(`${tag} choosing a level selects it`, sel.l === 5, JSON.stringify(sel));
  // sun recount for the selected building/level on 21 June
  await page.locator('#days button[data-day="06-21"]').click();
  await page.waitForFunction(() => { const r = window.studio.sunRows(window.studio.state.tower, '06-21'); return r[window.studio.state.level]; }, null, { timeout: 30000 });
  const shown = await page.evaluate(() => { const s = window.studio.state; const r = window.studio.sunRows(s.tower, '06-21')[s.level]; return { tower: s.tower, level: s.level, day: `${new Date().getFullYear()}-06-21`, m: Object.fromEntries(Object.entries(r).map(([a, v]) => [a, v.sunMinutes])) }; });
  const day = (await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date()))).slice(0, 4) + '-06-21';
  const diffs = Object.entries(shown.m).map(([a, m]) => [a, m, recountSun(shown.tower, shown.level, a, day)]);
  check(`${tag} sun hours on 21 June = independent recount (±30 min)`, diffs.every(([, m, r]) => Math.abs(m - r) <= 30), diffs.map(([a, m, r]) => `${a} ${m}/${r}`).join(' '));
  const sunText = await page.locator('#tab-sun .rows').innerText();
  check(`${tag} sun panel prints the computed hours`, Object.values(shown.m).every(m => sunText.includes((Math.round(m / 30) / 2).toFixed(1).replace(/\.0$/, '') + ' h')));
  // every figure on the noise and planning tabs traces to the recorded data
  for (const tab of ['noise', 'plan']) {
    await page.locator(`.tabs button[data-tab="${tab}"]`).click();
    const text = (await page.locator(`#tab-${tab}`).innerText()).replace(/(\d),(\d{3})/g, '$1$2');
    const nums = (text.match(/\d+(?:\.\d+)?/g) || []).filter(n => !/^20\d\d$/.test(n));
    const untraced = nums.filter(n => !allNumbers.has(n) && !allNumbers.has(String(Number(n))));
    check(`${tag} ${tab} tab: every figure traced to the recorded data`, untraced.length === 0, untraced.length ? `untraced: ${untraced.join(', ')}` : `${nums.length} figures`);
  }
  await page.locator('.tabs button[data-tab="view"]').click();
  const viewText = await page.locator('#tab-view').innerText();
  const vexp = data.views.by_tower[sel.b][sel.l];
  check(`${tag} view tab lists exactly the recorded line-of-sight targets`, Object.entries(vexp).every(([a, ids]) => ids.every(id => viewText.includes(data.views.targets.find(t => t.id === id).label))));
  // labels that keep it honest
  const body = await page.locator('body').innerText();
  check(`${tag} honest labels present`, /massing model from public planning documents/i.test(body) && /NOAA/.test(body) && /OpenStreetMap/.test(body) && !/photoreal/i.test(body.replace(/not photoreal/ig, '')));
  // embed copy event
  if (vp[0] === 1440) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#embedBtn').click(); await page.locator('#copyEmbed').click(); await page.waitForTimeout(300);
    const code = await page.locator('#embedCode').innerText();
    check('embed dialog gives the one-line script', code.includes('https://showhaus.app/studio/embed.js') && code.includes(`data-project="${SLUG}"`));
  }
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `studio-${vp[0]}x${vp[1]}.png`) });
  await page.waitForTimeout(500);
  const got = new Set(events.slice(before).map(e => e.e));
  check(`${tag} events sent: view, play, floor${vp[0] === 1440 ? ', embed_copy' : ''}`, ['view', 'play', 'floor', ...(vp[0] === 1440 ? ['embed_copy'] : [])].every(e => got.has(e)), [...got].join(','));
  check(`${tag} events carry no personal data`, events.slice(before).every(e => !Object.keys(e).some(k => /ip|email|ua|agent|cookie/i.test(k))));
  check(`${tag} zero console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------- 3. the embed on host pages ----------
for (const host of ['plain.html', 'agency.html']) for (const vp of VIEWPORTS) {
  const tag = `embed on ${host} ${vp[0]}×${vp[1]}`;
  const { ctx, page, errors } = await open(`${origin}/host/${host}`, vp);
  await page.waitForSelector('.showhaus-embed iframe', { timeout: 15000 });
  const lazy = await page.evaluate(() => !document.querySelector('.showhaus-embed iframe').getAttribute('src'));
  check(`${tag} iframe is lazy (no src before scroll)`, lazy);
  await page.locator('.showhaus-embed').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !!document.querySelector('.showhaus-embed iframe').src, null, { timeout: 10000 });
  const frame = await (await page.$('.showhaus-embed iframe')).contentFrame();
  await frame.waitForFunction(() => window.studio?.keyframes?.().length > 0, null, { timeout: 90000 }).catch(() => {});
  const ok = await frame.evaluate(() => !!document.querySelector('#map canvas') && document.body.classList.contains('embed')).catch(() => false);
  check(`${tag} walkthrough renders inside the frame`, ok);
  const geo = await page.evaluate(() => { const r = document.querySelector('.showhaus-embed iframe').getBoundingClientRect(), p = document.querySelector('.showhaus-embed').parentElement.getBoundingClientRect(); return { w: r.width, h: r.height, pw: p.width, sx: document.documentElement.scrollWidth - innerWidth }; });
  check(`${tag} responsive: fills its column, ≥420 px tall, no page overflow`, Math.abs(geo.w - geo.pw) < 40 && geo.h >= 420 && geo.sx <= 0, JSON.stringify(geo));
  const fo = await frame.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight })).catch(() => ({ x: 1, y: 1 }));
  check(`${tag} no overflow inside the frame`, fo.x <= 0 && fo.y <= 0, JSON.stringify(fo));
  check(`${tag} "Made with SHOWHAUS" link`, (await page.locator('.showhaus-embed a', { hasText: 'Made with SHOWHAUS' }).count()) === 1);
  check(`${tag} zero console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `embed-${host.replace('.html', '')}-${vp[0]}x${vp[1]}.png`) });
  await ctx.close();
}

// ---------- 4. the pilot page ----------
const offer = JSON.parse(await readFile(join(REPO, 'showhaus/studio/offer-showhaus-01.json'), 'utf8'));
for (const payment of [false, true]) {
  config = { payment, contact: null };
  for (const vp of VIEWPORTS) {
    const tag = `pilot (${payment ? 'payment link set' : 'no payment link'}) ${vp[0]}×${vp[1]}`;
    const { ctx, page, errors } = await open(`${base}pilot.html?src=judge`, vp);
    await page.waitForFunction(() => !/Checking/.test(document.getElementById('payNote').textContent), null, { timeout: 10000 });
    const text = await page.locator('body').innerText();
    check(`${tag} offer terms copied exactly`, [offer.price_line, offer.deposit_line, offer.delivery_line, offer.outcome_line].every(s => text.includes(s)), '');
    check(`${tag} says what is not built yet`, /not built yet/i.test(text) && /world engine/i.test(text) && /photoreal/i.test(text));
    const o = await overflow(page);
    check(`${tag} no horizontal overflow`, o.x <= 0, JSON.stringify(o));
    const btn = page.locator('#deposit');
    const label = await btn.innerText();
    if (!payment) check(`${tag} button falls back to "Reply to reserve a slot"`, label.trim() === 'Reply to reserve a slot');
    else {
      check(`${tag} deposit button points at /pay/studio-pilot`, (await btn.getAttribute('href')).startsWith('/pay/studio-pilot'));
      if (vp[0] === 1440) {
        let reached = null;
        page.on('request', r => { if (r.url().startsWith('https://buy.stripe.com/')) reached = r.url(); });
        await page.route('https://buy.stripe.com/**', r => r.fulfill({ status: 200, body: 'stripe stand-in' }));
        await btn.click(); await page.waitForTimeout(1500);
        check(`${tag} deposit button reaches the payment page and logs checkout_start`, reached === 'https://buy.stripe.com/judge-test' && events.some(e => e.e === 'checkout_start' && e.src === 'judge'), reached || 'not reached');
      }
    }
    check(`${tag} zero console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `pilot-${payment ? 'pay' : 'reserve'}-${vp[0]}x${vp[1]}.png`), fullPage: true });
    await ctx.close();
  }
}

// ---------- 5. the email kit ----------
const kitDir = join(ROOT, `showhaus/studio/${SLUG}`);
const gif = await readFile(join(kitDir, 'walkthrough.gif'));
let w = gif.readUInt16LE(6), h = gif.readUInt16LE(8), delay = 0, frames = 0;
for (let i = 0; i < gif.length - 6; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) { delay += gif.readUInt16LE(i + 4); frames++; }
check(`GIF ${w}×${h}, ≥ 560 px wide`, w >= 560);
check(`GIF ${(gif.length / 1048576).toFixed(2)} MB ≤ 1.8 MB`, gif.length <= 1.8 * 1048576);
check(`GIF duration ${(delay / 100).toFixed(2)} s ≈ 5 s (${frames} frames)`, Math.abs(delay / 100 - 5) <= 0.25);
for (const f of ['walkthrough.mp4', 'poster.png', 'still-sunrise.png', 'still-winter-3pm.png', 'still-top-floor-view.png']) {
  const s = await stat(join(kitDir, f)).catch(() => null);
  check(`kit file ${f} present`, !!s && s.size > 10000, s ? `${(s.size / 1024).toFixed(0)} KB` : 'missing');
}

await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
