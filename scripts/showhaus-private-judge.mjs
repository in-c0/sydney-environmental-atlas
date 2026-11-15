// SHOWHAUS — click-through judge for the owner's controls on a walk listing (Playwright, desktop + 390 px):
// claim → ask for real finishes (paid by the claimant; no price until one is configured) → make the home private →
// the viewer, the gallery and the scene files all honour it → public again.
//   node scripts/showhaus-private-judge.mjs [--shots <dir>]
// Starts scripts/showhaus-local-worker.mjs (the real Worker, in-memory D1). The claim is verified by writing to that D1,
// which stands in for the emailed code.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const SHOTS = arg('--shots', join(tmpdir(), 'showhaus-private-shots'));
const SLUG = 'buildtec-avalon', NOTE = 'This home has been made private at the builder’s request.';
const { serve, env } = await import('./showhaus-local-worker.mjs');
const server = await serve(8793);
const BASE = 'http://127.0.0.1:8793/showhaus';
const { chromium } = await import('playwright');
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

async function run(name, viewport, touch, n) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const shot = s => page.screenshot({ path: join(SHOTS, `${name}-${s}.png`) });
  const overflow = async s => check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no sideways scroll (${s})`);
  await page.addInitScript(() => { try { sessionStorage.setItem('sh_synth', '1'); } catch {} });
  await page.goto(`${BASE}/claim/?p=${SLUG}`);
  await page.waitForSelector('#gives:not([hidden])');
  check((await page.textContent('#gives')).includes('Paid by you'), `${name}: the claim page says what a claim gives and who pays`);
  await overflow('intro'); await shot('1-intro');
  await page.click('#askPrivate');
  await page.waitForTimeout(1100); // first-visit hint settles on guest
  await page.locator('.mode[data-mode=guest]').click();
  await page.click('#modeNext');
  await page.waitForSelector('#s-details:not([hidden])');
  check((await page.textContent('#submit')).trim() === 'Make Avalon private', `${name}: the take-down path is labelled`);
  await page.click('label:has(input[name=role][value=builder])');
  await page.fill('input[name=company]', 'Harbour Homes'); await page.fill('input[name=licence]', '51 824 753 556');
  await page.fill('input[name=website]', 'harbourhomes.com.au'); await page.fill('input[name=email]', `sam${n}@harbourhomes.com.au`);
  await page.click('#submit');
  await page.waitForSelector('#s-done:not([hidden])');
  check((await page.textContent('#privNote')).includes('the moment your work email is confirmed'), `${name}: an unverified request hides nothing and says why`);
  check(await page.isHidden('#privBtn'), `${name}: no private switch before verification`);
  await page.click('#finBtn'); await page.waitForFunction(() => /Request saved/.test(document.getElementById('finNote').textContent));
  check((await page.textContent('#finNote')).includes('nothing is charged and nothing is uploaded'), `${name}: finishes request saved, no charge, no upload`);
  check(await page.isHidden('#finDrop'), `${name}: upload stays closed before payment`);
  check(!/\$\s?\d/.test(await page.textContent('body')), `${name}: no price shown`);
  await overflow('done'); await shot('2-requested');
  // the emailed code, stood in for: the claim becomes verified and its pending request applies on the next private call
  env.OPS_DB._db.prepare("UPDATE sh_claims SET status = 'verified' WHERE slug = ? AND company = 'Harbour Homes'").run(SLUG);
  env.OPS_DB._db.prepare('DELETE FROM sh_private_pending').run();
  await page.reload(); await page.waitForSelector('#privBtn:not([hidden])');
  await page.click('#privBtn'); await page.waitForFunction(() => document.getElementById('privBtn').textContent === 'Make it public again');
  check((await page.textContent('#h-done')).trim() === 'This home is private.', `${name}: the claimant sees it is private`);
  await shot('3-private');
  const visitor = await ctx.newPage();
  await visitor.goto(`${BASE}/walk/?p=${SLUG}`); await visitor.waitForFunction(n => document.getElementById('load').textContent.includes(n), NOTE);
  check(true, `${name}: the viewer shows the private notice`);
  check((await visitor.request.get(`${BASE}/walk/data/${SLUG}/room.js`)).status() === 410, `${name}: the scene file is not served`);
  await visitor.screenshot({ path: join(SHOTS, `${name}-4-viewer.png`) });
  await visitor.goto(`${BASE}/walk/`); await visitor.waitForSelector('.g-card--private');
  check((await visitor.textContent('.g-card--private')).includes(NOTE) && !(await visitor.$(`a.g-card[data-slug=${SLUG}]`)), `${name}: the gallery card is a notice, not a link`);
  await visitor.screenshot({ path: join(SHOTS, `${name}-5-gallery.png`) });
  await page.click('#privBtn'); await page.waitForFunction(() => document.getElementById('privBtn').textContent === 'Make it private');
  await new Promise(r => setTimeout(r, 300));
  check((await visitor.request.get(`${BASE}/walk/data/${SLUG}/room.js`)).status() === 200, `${name}: public again restores the scene`);
  check(!errors.length, `${name}: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}
try {
  await run('desktop', { width: 1280, height: 800 }, false, 1);
  await run('phone', { width: 390, height: 780 }, true, 2);
} catch (e) { check(false, 'judge crashed: ' + (e && e.message)); }
await browser.close(); server.close && server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed', '· shots:', SHOTS);
process.exit(failures.length ? 1 : 0);
