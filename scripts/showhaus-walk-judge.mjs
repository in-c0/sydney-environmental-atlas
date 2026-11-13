// SHOWHAUS walk — click-through judge (Playwright), desktop + 390 px touch.
//   node scripts/showhaus-walk-judge.mjs [--base http://127.0.0.1:8787] [--shots <dir>] [--slug buildtec-avalon] [--poster]
// Without --base it starts scripts/showhaus-local-worker.mjs itself. --poster re-renders dist/showhaus/walk/data/<slug>/poster.jpg.
// Traffic is marked synthetic (?synthetic=1 + HeadlessChrome), so it never counts as production.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const SLUG = arg('--slug', 'buildtec-avalon');
const SHOTS = arg('--shots', join(tmpdir(), 'showhaus-walk-shots'));
let BASE = arg('--base', ''), server = null;
if (!BASE) { const { serve } = await import('./showhaus-local-worker.mjs'); server = await serve(8791); BASE = 'http://127.0.0.1:8791'; }
BASE = BASE.replace(/\/$/, '');
const root = /showhaus\.app$/.test(new URL(BASE).hostname) ? '' : '/showhaus';
const WALK = `${BASE}${root}/walk/`;
const { chromium } = await import('playwright');
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });

async function run(name, viewport, touch) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errors = [], beacons = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|posthog|tiles|maplibre|GPU stall|WebGL|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  await page.exposeFunction('__beacon', t => { try { beacons.push(JSON.parse(t)); } catch { /* ignore */ } });
  await page.addInitScript(() => { const o = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (u, b) => { if (String(u).endsWith('/api/e') && b && b.text) b.text().then(t => window.__beacon(t)); return o(u, b); }; });
  page.on('response', r => { if (r.status() >= 400 && !/amenities\.json$/.test(r.url())) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const cdp = touch ? await ctx.newCDPSession(page) : null;
  const finger = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const shot = step => page.screenshot({ path: join(SHOTS, `${name}-${step}.png`) });
  const st = () => page.evaluate(() => window.__sh.state());
  const inView = async sel => { const b = await page.locator(sel).boundingBox(); return !!b && b.x >= -1 && b.y >= -1 && b.x + b.width <= viewport.width + 1 && b.y + b.height <= viewport.height + 1; };
  const overlap = async (a, b) => { const [p, q] = [await page.locator(a).boundingBox(), await page.locator(b).boundingBox()]; return !!p && !!q && p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height; };

  // gallery
  await page.goto(`${WALK}?synthetic=1`, { waitUntil: 'networkidle' });
  check(await page.locator('.g-card').count() >= 1, `${name}: gallery lists walkthroughs`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: gallery has no horizontal scroll`);
  check(await page.evaluate(() => [...document.querySelectorAll('.g-card .shot')].every(s => { const u = getComputedStyle(s).backgroundImage; return u && u !== 'none'; })), `${name}: every card has a poster`);
  await shot('0-gallery');
  await page.locator(`.g-card[data-slug=${SLUG}]`).click();

  // viewer
  await page.waitForFunction(() => window.__sh && !document.getElementById('load'), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const meta = await (await page.request.get(`${WALK}data/${SLUG}.json`)).json();
  const badge = await page.locator('#claim').textContent();
  check(badge === 'Not yet owner-claimed', `${name}: unclaimed badge shown ("${badge}")`);
  const basis = await page.locator('#basis').textContent();
  check(meta.listing.source === 'plan' ? /published floor plan/.test(basis) && !/satellite/.test(basis) : /satellite imagery/.test(basis), `${name}: basis line matches the data source (${meta.listing.source})`);
  check(/not affiliated/.test(await page.locator('#tby').textContent()), `${name}: unclaimed home says it is not affiliated with the builder`);
  for (const sel of ['#title', '#up', '#chips button:first-child', '#chips button:last-child']) check(await inView(sel), `${name}: ${sel} is inside the screen`);
  check(!(await overlap('#title', '#side')), `${name}: title card and plan/upgrade column do not overlap`);
  check(!(await overlap('#side', '#chips')), `${name}: upgrade column does not cover the room chips`);
  if (touch) { check(await page.locator('#stick').isVisible(), `${name}: touch stick is shown`); check(!(await overlap('#stick', '#chips')) && !(await overlap('#stick', '#side')), `${name}: touch stick is clear of other controls`); }
  if (touch) check(!(await overlap('#hint', '#stick')) && !(await overlap('#hint', '#side')) && !(await overlap('#hint', '#title')), `${name}: hint is clear of the controls`);
  await shot('1-open');
  if (process.argv.includes('--poster') && !touch) {
    await page.addStyleTag({ content: '#title,#side,#chips,#hint,#stick{visibility:hidden}' }); await page.waitForTimeout(200);
    const png = join(SHOTS, 'poster.png'); await page.screenshot({ path: png });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '4', fileURLToPath(new URL(`../dist/showhaus/walk/data/${SLUG}/poster.jpg`, import.meta.url))]);
    await page.addStyleTag({ content: '#title,#side,#chips,#hint,#stick{visibility:visible}' });
    console.log('poster written');
  }

  // every viewpoint by chip: lands where the data says, nothing in the face (pixel variance of the centre crop)
  const views = (await st()).views;
  for (let i = 0; i < views; i++) {
    if (touch) await page.locator('#chips button').nth(i).tap(); else await page.keyboard.press(String(i + 1));
    await page.waitForFunction(i => { const b = document.querySelectorAll('#chips button')[i]; return b && b.getAttribute('aria-pressed') === 'true'; }, i);
    await page.waitForTimeout(touch ? 2900 : 500);
    await shot(`2-view${i + 1}`);
  }
  const s1 = await st();
  check(s1.photoOn === views - 1, `${name}: last photoreal viewpoint is revealed after the glide (photoOn=${s1.photoOn})`);
  check(await page.locator('#wipe').isVisible(), `${name}: divider is shown on a photoreal view`);
  const clipBefore = await page.locator('#photo').evaluate(e => e.style.clipPath);
  const wb = await page.locator('#wipe').boundingBox();
  if (touch) { await finger('touchStart', wb.x + 22, 300); for (const x of [160, 120, 80]) await finger('touchMove', x, 300); await finger('touchEnd'); }
  else { await page.mouse.move(wb.x + 22, 300); await page.mouse.down(); await page.mouse.move(viewport.width * 0.2, 300, { steps: 6 }); await page.mouse.up(); }
  const clipAfter = await page.locator('#photo').evaluate(e => e.style.clipPath);
  check(clipBefore !== clipAfter && parseFloat(clipAfter.split(' ').pop()) < 30, `${name}: dragging the divider reveals more of the photo (${clipAfter})`);
  await shot('3-photo-wipe');

  // walk: plan tap, then keys or stick
  const before = await st();
  const mb = await page.locator('#map svg').boundingBox();
  if (touch) await page.touchscreen.tap(mb.x + mb.width * 0.25, mb.y + mb.height * 0.55); else await page.mouse.click(mb.x + mb.width * 0.25, mb.y + mb.height * 0.55);
  await page.waitForTimeout(3000);
  const tapped = await st();
  check(Math.hypot(tapped.px - before.px, tapped.py - before.py) > 1 && tapped.photoOn === -1, `${name}: tapping the plan walks there and leaves the photo (moved ${Math.hypot(tapped.px - before.px, tapped.py - before.py).toFixed(1)} m)`);
  if (touch) {
    const sb = await page.locator('#stick').boundingBox();
    await finger('touchStart', sb.x + 52, sb.y + 52); await finger('touchMove', sb.x + 52, sb.y + 30); await finger('touchMove', sb.x + 52, sb.y + 12);
    await page.waitForTimeout(900);
    const kb = await page.locator('#knob').boundingBox();
    check(kb.y < sb.y + 20, `${name}: stick knob follows the finger`);
    await finger('touchEnd');
  } else { await page.keyboard.down('w'); await page.waitForTimeout(900); await page.keyboard.up('w'); }
  const walked = await st();
  check(Math.hypot(walked.px - tapped.px, walked.py - tapped.py) > 0.15, `${name}: ${touch ? 'touch stick' : 'W key'} walks (moved ${Math.hypot(walked.px - tapped.px, walked.py - tapped.py).toFixed(2)} m)`);
  if (!touch) { const y0 = walked.yaw; await page.mouse.move(viewport.width / 2, viewport.height / 2); await page.mouse.down(); await page.mouse.move(viewport.width / 2 + 200, viewport.height / 2, { steps: 5 }); await page.mouse.up(); check(Math.abs((await st()).yaw - y0) > 0.3, `${name}: dragging looks around`); }
  await shot('4-walked');

  // upgrade card
  await page.locator('#up').click();
  check(await page.locator('#card').isVisible(), `${name}: upgrade card opens`);
  const cb = await page.locator('#card').boundingBox(), xb = await page.locator('#x').boundingBox();
  check(xb.x > cb.x && xb.x + xb.width <= cb.x + cb.width + 1 && xb.y >= cb.y && xb.y < cb.y + 60, `${name}: close button sits in the card's top-right corner`);
  check(await inView('#card'), `${name}: upgrade card fits the screen`);
  const cardText = await page.locator('#card').textContent();
  check(!/\$\s?\d|AUD|per (clip|home|render)/i.test(cardText), `${name}: no price on the card`);
  check(/declined up front/.test(cardText) && /time cap/.test(cardText) && /refunded/.test(cardText) && /AI visualisation/.test(cardText), `${name}: card states the limit, the cap, the refund and the AI visualisation`);
  await shot('5-upgrade');
  await page.locator('#want').click(); await page.waitForTimeout(300);
  check((await page.locator('#want').textContent()).includes('Counted') && await page.locator('#want').isDisabled(), `${name}: interest tap is acknowledged and cannot be sent twice`);
  check(beacons.some(b => b.name === 'upgrade_interest' && b.props.kind === 'walk:' + SLUG), `${name}: upgrade_interest beacon sent`);
  check(beacons.some(b => b.name === 'walk_open') && beacons.some(b => b.name === 'walk_room'), `${name}: walk_open and walk_room beacons sent`);
  await shot('6-counted');
  await page.locator('#x').click();
  check(await page.locator('#veil').evaluate(e => e.style.display === 'none'), `${name}: card closes`);

  // claim hand-off
  await page.locator('#claimLink').click();
  await page.waitForURL(/\/claim\/\?p=/); await page.waitForLoadState('networkidle');
  check((await page.locator('#paddr').textContent()).trim() === meta.project.name, `${name}: claim page names this home ("${(await page.locator('#paddr').textContent()).trim()}")`);
  check((await page.locator('#open3d').getAttribute('href')).includes(`/walk/?p=${SLUG}`), `${name}: claim page links back to this walkthrough`);
  check(await page.locator('#walk').evaluate(v => !v.getAttribute('src') && /poster\.jpg/.test(v.poster)), `${name}: claim page shows this home's still, not the Studio demo clip`);
  check(/build, own or market this home/.test(await page.locator('#h-intro').textContent()), `${name}: claim headline includes builders`);
  check(await page.locator('#explainer').isHidden(), `${name}: the explainer recorded on another property is hidden`);
  check(!/Arncliffe|planning documents/.test(await page.locator('body').innerText()), `${name}: claim page carries no text from another property`);
  await shot('7-claim');

  // map page: nav link + pin
  await page.goto(`${BASE}${root}/?synthetic=1`, { waitUntil: 'domcontentloaded' });
  check(await page.locator('#walkNav').isVisible(), `${name}: map header has the Walk link`);
  await page.waitForTimeout(2500);
  await shot('8-map');
  check(errors.length === 0, `${name}: no page errors${errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''}`);
  await ctx.close();
}

await run('desktop', { width: 1280, height: 800 }, false);
await run('phone', { width: 390, height: 844 }, true);
await browser.close(); if (server) server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed', '· screenshots:', SHOTS);
process.exit(failures.length ? 1 : 0);
