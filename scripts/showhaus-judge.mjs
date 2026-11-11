// Outside judge for SHOWHAUS (living-data-hud step 5). Serves dist/ locally, drives headless Chromium.
// Usage: node scripts/showhaus-judge.mjs [--shots dir]
// Needs: npm i --no-save playwright && npx playwright install chromium
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/showhaus/`;
const rents = JSON.parse(await readFile(join(ROOT, 'showhaus/data/rents.json'), 'utf8'));
const places = JSON.parse(await readFile(join(ROOT, 'showhaus/data/places.json'), 'utf8'));
const amen = await readFile(join(ROOT, 'showhaus/data/amenities.json'), 'utf8').then(JSON.parse).catch(() => null);
function monthsWithLeases(pci, beds, maxRent) {
  const seen = new Set();
  for (let i = 0; i < rents.w.length; i++) if (rents.pc[i] === pci && (!beds || beds.includes(rents.b[i] >= 4 ? 4 : rents.b[i])) && (maxRent == null || rents.w[i] <= maxRent)) seen.add(rents.m[i]);
  return seen.size;
}

// Independent recount from the raw file (not from the app's code).
function recount({ postcode = null, maxRent = null, beds = null } = {}) {
  const pi = postcode == null ? null : rents.postcodes.indexOf(Number(postcode));
  let n = 0;
  for (let i = 0; i < rents.w.length; i++) {
    if (pi != null && rents.pc[i] !== pi) continue;
    if (maxRent != null && rents.w[i] > maxRent) continue;
    if (beds != null && !beds.includes(rents.b[i] >= 4 ? 4 : rents.b[i])) continue;
    n++;
  }
  return n;
}
function recountArea(name) {
  const a = places.areas.find(x => x.name === name); const set = new Set(a.pcs.map(pc => rents.postcodes.indexOf(pc)).filter(i => i >= 0));
  let n = 0; for (let i = 0; i < rents.w.length; i++) if (set.has(rents.pc[i])) n++; return n;
}
function median(post, beds, maxRent) {
  const pi = rents.postcodes.indexOf(Number(post)); const v = [];
  for (let i = 0; i < rents.w.length; i++) if (rents.pc[i] === pi && (!beds || beds.includes(rents.b[i] >= 4 ? 4 : rents.b[i])) && (maxRent == null || rents.w[i] <= maxRent)) v.push(rents.w[i]);
  v.sort((a, b) => a - b); const pos = (v.length - 1) / 2; return Math.round(v[Math.floor(pos)] + (v[Math.ceil(pos)] - v[Math.floor(pos)]) * (pos - Math.floor(pos)));
}

const { chromium } = await import('playwright');
// Use an already-installed Chromium in restricted session executors; default to Playwright's browser elsewhere.
const browser = await chromium.launch({ executablePath: process.env.SHOWHAUS_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const VIEWPORTS = [[1440, 900], [1280, 720], [390, 844]];
// A suburb whose name is unique, in the busiest postcode.
const perPc = new Map(); rents.pc.forEach(i => perPc.set(i, (perPc.get(i) || 0) + 1));
const names = new Map(); places.suburbs.forEach(s => names.set(s[0], (names.get(s[0]) || 0) + 1));
const cand = places.suburbs.filter(s => names.get(s[0]) === 1 && rents.postcodes.includes(Number(s[1]))).sort((a, b) => (perPc.get(rents.postcodes.indexOf(Number(b[1]))) || 0) - (perPc.get(rents.postcodes.indexOf(Number(a[1]))) || 0));
const [busiest, busiestPc] = cand[0];

async function noOverflow(page, label) {
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement;
    const scroll = doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1;
    const out = [];
    for (const el of document.querySelectorAll('.act, .card, .lenses, .bar > *, .selection .tok')) {
      const cs = getComputedStyle(el); if (cs.opacity === '0' || cs.display === 'none' || el.offsetParent === null && cs.position !== 'fixed') continue;
      const b = el.getBoundingClientRect(); if (!b.width) continue;
      if (b.left < -1 || b.top < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1) out.push(el.className || el.id);
    }
    return { scroll, out };
  });
  check(`${label}: no page scroll, nothing outside the viewport`, !r.scroll && !r.out.length, r.out.join(', '));
}

for (const [w, h] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/tiles\.openfreemap|net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SHOWHAUS?.rents, null, { timeout: 30000 });
  const tag = `${w}×${h}`;
  check(`${tag} Living Atlas opens in Explore`, await page.locator('.views .view.on').innerText() === 'Explore' && await page.locator('.explore-shell').isVisible());
  check(`${tag} unreleased experiences are clearly unavailable`, await page.locator('.views .view[disabled]').count() === 2);
  check(`${tag} reading panel is opaque over map`, await page.locator('.explore-shell').evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(250, 248, 243)'));
  const typography = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    heading: getComputedStyle(document.querySelector('.explore-head h1')).fontFamily,
    brand: getComputedStyle(document.querySelector('.bar .brand')).fontFamily,
  }));
  check(`${tag} modern readable type is applied`, typography.body.startsWith('Inter') && typography.heading.startsWith('Manrope') && typography.brand.startsWith('Manrope'), JSON.stringify(typography));
  await noOverflow(page, `${tag} act 1`);
  if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.waitForTimeout(1200); await page.screenshot({ path: `${shotsDir}/act1-${w}x${h}.png` }); }

  // Act 1: counter = recount for the whole window, then per-keystroke.
  const total = await page.locator('#c1').innerText();
  check(`${tag} act 1 total counter equals recount`, total.replace(/,/g, '') === String(recount()), `${total} vs ${recount()}`);
  await page.fill('#where', 'k');
  check(`${tag} 1-letter query refuses to search`, (await page.locator('#whereHint').innerText()).includes('Keep typing'));
  // Reaction time measured inside the page: keystroke → counter updated (synchronous handler).
  const ms = await page.evaluate(q => { const el = document.getElementById('where'); const t = performance.now(); el.value = q; el.dispatchEvent(new Event('input')); const ok = document.getElementById('c1label').textContent.includes('new leases in'); return ok ? performance.now() - t : 9999; }, busiest.slice(0, 5));
  check(`${tag} first counter reacts < 300 ms`, ms < 300, `${Math.round(ms)} ms`);
  await page.fill('#where', busiest);
  const c1 = (await page.locator('#c1').innerText()).replace(/,/g, '');
  check(`${tag} suburb counter equals recount (postcode ${busiestPc})`, c1 === String(recount({ postcode: busiestPc })), `${c1} vs ${recount({ postcode: busiestPc })}`);
  await page.fill('#where', busiest.slice(0, 3) + 'x' + busiest.slice(4));
  const typo = await page.locator('#whereHint').innerText();
  check(`${tag} typo gets an honest no-match + suggestion`, /Did you mean|No recorded/.test(typo), typo.slice(0, 80));
  for (const [q, name] of [['sydney', 'Greater Sydney'], ['CBD', 'Sydney CBD'], ['nsw', 'New South Wales'], ['eastern suburbs', 'Eastern Suburbs'], ['randwick council', 'Randwick Council']]) {
    await page.fill('#where', q);
    const first = await page.locator('#suggest button').first().innerText();
    const cnt = (await page.locator('#c1').innerText()).replace(/,/g, '');
    check(`${tag} "${q}" → ${name}, counter equals recount`, first.startsWith(name) && cnt === String(recountArea(name)), `${first.split('\n')[0]} · ${cnt} vs ${recountArea(name)}`);
  }
  await page.fill('#where', 'melbourne');
  check(`${tag} another state is named honestly, not "no match"`, (await page.locator('#whereHint').innerText()).includes('New South Wales'));
  await page.fill('#where', '$1.2m');
  check(`${tag} a price in the place field is recognised`, (await page.locator('#whereHint').innerText()).includes('budget'));
  await page.fill('#where', busiest); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.dataset.act === '2');
  await noOverflow(page, `${tag} act 2`);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/act2-${w}x${h}.png` });

  // Act 2: budget slider + bedrooms recount, median.
  await page.locator('#budget').fill('30'); // index 30 → $1,000/wk
  await page.locator('#budget').dispatchEvent('input');
  await page.click('[data-bed="2"]');
  const c2 = (await page.locator('#c2').innerText()).replace(/,/g, '');
  const want = recount({ postcode: busiestPc, maxRent: 1000, beds: [2] });
  check(`${tag} budget+bedroom counter equals recount`, c2 === String(want), `${c2} vs ${want}`);
  const m2 = (await page.locator('#m2').innerText()).replace(/[$,/wk]/g, '');
  check(`${tag} median equals recount`, m2 === String(median(busiestPc, [2], 1000)), `${m2} vs ${median(busiestPc, [2], 1000)}`);
  await page.click('[data-mode="buy"]');
  check(`${tag} buying says sold prices are not available, not zero`, (await page.locator('#m2').innerText()).includes('licence') && !(await page.locator('#rentHint').isHidden()));
  await page.click('[data-mode="rent"]');
  const sel = await page.locator('#selection').innerText();
  const full = w >= 760 ? sel.includes('$1,000/wk') && sel.includes('2 bed') : /\+3 filters/.test(sel); // phones fold extra filters into one token
  check(`${tag} selection line states place, budget and beds`, sel.includes(busiest) && full, sel.replace(/\s+/g, ' ').slice(0, 90));

  await page.click('[data-go="3"]'); await page.waitForFunction(() => document.body.dataset.act === '3');
  await noOverflow(page, `${tag} act 3`);
  check(`${tag} preferences action stays visible without scrolling`, await page.locator('#act3 .next').evaluate(el => {
    const b = el.getBoundingClientRect(), stage = document.querySelector('.explore-stage').getBoundingClientRect();
    return b.top >= stage.top - 1 && b.bottom <= stage.bottom + 1;
  }));
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/act3-${w}x${h}.png` });
  const c3before = (await page.locator('#c3').innerText()).replace(/,/g, '');
  check(`${tag} act 3 count starts equal to act 2`, c3before === c2, `${c3before} vs ${c2}`);
  await page.click('[data-want="quiet"]');
  const c3 = (await page.locator('#c3').innerText()).replace(/,/g, '');
  if (amen) {
    const q = amen.postcodes[busiestPc]?.quiet ?? amen.postcodes[Number(busiestPc)]?.quiet;
    const wantQ = q != null && q >= 0.5 ? want : 0;
    check(`${tag} "quiet street" recounts leases from measured postcodes`, c3 === String(wantQ), `${c3} vs ${wantQ} (quiet share ${q})`);
  } else {
    check(`${tag} without measures, area wants say so and do not change the count`, c3 === c2 && (await page.locator('[data-want="quiet"]').innerText()).includes('not measured'), c3);
  }
  await page.click('[data-want="commute"]');
  check(`${tag} commute want opens a place input`, await page.locator('#commuteWhere').isVisible());
  await page.click('[data-want="commute"]');
  await page.click('[data-want="quiet"]');
  check(`${tag} hidden act 2 does not capture clicks`, await page.evaluate(() => getComputedStyle(document.getElementById('act2')).pointerEvents === 'none'));
  await page.click('[data-go="4"]'); await page.waitForFunction(() => document.body.dataset.act === '4');
  await page.waitForTimeout(4000);
  await noOverflow(page, `${tag} act 4`);
  const hero = await page.evaluate(() => window.SHOWHAUS.pc.features.filter(f => f.properties.n > 0).length);
  check(`${tag} hero colours real postcodes`, hero > 100, `${hero} postcodes with leases`);
  await page.click('[data-tab="rent"]');
  const rentFact = await page.locator('#pane .fact b').first().innerText();
  check(`${tag} place card leads with a counted median`, /^\$[\d,]+\/wk$/.test(rentFact), rentFact);
  const pts = await page.locator('#pane .timeline circle.pt').count();
  const pci = await page.evaluate(() => window.SHOWHAUS.state.point.pci);
  const wantPts = monthsWithLeases(pci, [2], 1000);
  check(`${tag} rent history timeline has one point per month with leases`, pts === wantPts && pts > 0, `${pts} vs ${wantPts}`);
  await page.click('[data-tab="adv"]');
  check(`${tag} Advanced is behind the Pro lock (blurred, labelled coming soon)`, await page.locator('#pane .pro-lock').isVisible() && await page.locator('#pane .pro-body.locked').count() === 1);
  await page.click('#pinA');
  check(`${tag} compare says what it does`, (await page.locator('#pinA').innerText()) === 'Stop comparing' && (await page.locator('#compare').innerText()).includes('pinned'));
  await page.click('#pinA');
  await page.click('[data-lens="3d"]');
  check(`${tag} 3D lens is a Pro preview`, await page.locator('#proLens').isVisible());
  await page.click('#proClose');
  check(`${tag} closing the Pro preview returns to the map`, await page.locator('#proLens').isHidden() && await page.evaluate(() => window.SHOWHAUS.state.lens === 'map'));
  await page.evaluate(() => { const S = window.SHOWHAUS, p = S.state.point; S.map.jumpTo({ center: [p.lng, p.lat], zoom: 13.5 }); });
  if (shotsDir) {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${shotsDir}/act4-zoomed-${w}x${h}.png` });
  }
  const calm = await page.evaluate(() => {
    const m = window.SHOWHAUS.map;
    return { labels: !!m.getLayer('pc-nodes-n'), labelVisibility: m.getLayoutProperty('pc-nodes-n', 'visibility'),
      noLeaseDots: !m.getLayer('lease-dots') && !m.getLayer('lease-ring') && !m.getSource('leases'),
      noFallbackDots: !m.getLayer('pc-nodes'),
      countLabel: JSON.stringify(m.getLayoutProperty('pc-nodes-n', 'text-field')),
      clusterSource: m.getSource('pcn')._options?.cluster,
    };
  });
  check(`${tag} zoomed map uses approximate count capsules, not dense lease dots`, calm.labels && calm.labelVisibility !== 'none' && calm.noLeaseDots && calm.noFallbackDots && calm.countLabel.includes('leases') && calm.countLabel.includes('≈'), JSON.stringify(calm));
  const cityFiltered = await page.evaluate(() => window.SHOWHAUS.pc.features.reduce((n, f) => n + f.properties.n, 0));
  check(`${tag} clustered data preserves actual filtered lease counts`, cityFiltered === recount({ maxRent: 1000, beds: [2] }), `${cityFiltered} vs ${recount({ maxRent: 1000, beds: [2] })}`);
  const clusters = await page.evaluate(async () => {
    const m = window.SHOWHAUS.map;
    m.jumpTo({ center: [151.05, -33.86], zoom: 9.5 });
    await new Promise(resolve => setTimeout(resolve, 550));
    const seen = new Set();
    const agg = m.querySourceFeatures('pcn').filter(f => f.properties.cluster && !seen.has(f.properties.cluster_id) && seen.add(f.properties.cluster_id));
    const sample = agg.find(f => f.properties.point_count > 1 && f.properties.point_count < 500);
    if (!sample) return { available: agg.length, valid: false };
    const leaves = await m.getSource('pcn').getClusterLeaves(sample.properties.cluster_id, sample.properties.point_count, 0);
    const sum = leaves.reduce((n, f) => n + Number(f.properties.n), 0);
    const expansionZoom = await m.getSource('pcn').getClusterExpansionZoom(sample.properties.cluster_id);
    return { available: agg.length, postcodes: sample.properties.point_count, sum, leaseTotal: sample.properties.leases, expansionZoom,
      valid: sum === Number(sample.properties.leases) && sum >= sample.properties.point_count && expansionZoom > 9.5 };
  });
  check(`${tag} clusters sum leases (not postcode points) and expand on tap`, clusters.valid, JSON.stringify(clusters));
  check(`${tag} legend distinguishes grouped lease counts from rent shading`, (await page.locator('#legend').innerText()).includes('Capsules ≈ new leases') && (await page.locator('#legend').innerText()).includes('not individual home locations'));
  // Every live request has a 15 s timeout, so each lens must leave 'load' within ~20 s (ok, none or err).
  await page.waitForFunction(() => { const S = window.SHOWHAUS; const e = S.evidence.get(S.keyOf(S.state.point)); return e && Object.values(e).every(v => v.s !== 'load'); }, null, { timeout: 22000 }).catch(() => {});
  const statuses = await page.evaluate(() => { const S = window.SHOWHAUS; const e = S.evidence.get(S.keyOf(S.state.point)); return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v.s])); });
  check(`${tag} every evidence lens resolved (ok/none/err, never stuck)`, Object.values(statuses).every(s => s !== 'load'), JSON.stringify(statuses));

  // presets survive reload and delete with ×
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.SHOWHAUS?.rents);
  const pre = await page.locator('#presets button.go').allInnerTexts();
  check(`${tag} preset survives reload`, pre.includes(busiest), pre.join(','));
  if (pre.length) { await page.locator('#presets li').first().hover(); await page.locator('#presets button.x').first().click(); }
  check(`${tag} preset deletes with ×`, !(await page.locator('#presets button.go').allInnerTexts()).includes(busiest));

  if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.fill('#where', busiest); await page.keyboard.press('Enter'); await page.click('[data-go="3"]'); await page.click('[data-go="4"]'); await page.waitForTimeout(5000); await page.screenshot({ path: `${shotsDir}/act4-${w}x${h}.png` }); }
  check(`${tag} zero console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}
await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
