// SHOWHAUS claim flow — click-through judge and explainer recorder (Playwright + ffmpeg).
//   node scripts/showhaus-claim-judge.mjs [--base http://127.0.0.1:8787] [--shots <dir>]      click through every step, desktop + 390 px
//   node scripts/showhaus-claim-judge.mjs --explainer [--base …]                              record dist/showhaus/claim/media/claim-explainer.*
//   node scripts/showhaus-claim-judge.mjs --email                                             email poster + rendered previews of showhaus/outreach/claim-arncliffe-central/email.html
// --base must serve the Worker (wrangler dev, a preview URL or https://showhaus.app). Traffic is marked synthetic (?synthetic=1 +
// HeadlessChrome user agent), so it never counts as production. Uses example domains only; never a real person's address.
import { mkdir, rm, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const BASE = arg('--base', 'http://127.0.0.1:8787').replace(/\/$/, '');
const SHOTS = arg('--shots', join(tmpdir(), 'showhaus-claim-shots'));
const MEDIA = fileURLToPath(new URL('../dist/showhaus/claim/media/', import.meta.url));
const pathFor = p => (/showhaus\.app$|127\.0\.0\.1|localhost/.test(new URL(BASE).hostname) ? p : '/showhaus' + p); // wrangler dev answers as showhaus.app
const CLAIM = `${BASE}${pathFor('/claim/')}?p=arncliffe-central&utm_source=judge&synthetic=1`;
const { chromium } = await import('playwright');
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n% SHOWHAUS judge sample: authority to market (synthetic)\n'), Buffer.alloc(40_000, 32), Buffer.from('\n%%EOF\n')]);

async function fillDetails(page, { email, website, slow = 0 }) {
  await page.locator('.roles label').filter({ hasText: 'Listing agent' }).click();
  const type = async (sel, v) => { const el = page.locator(sel); await el.click(); if (slow) await el.pressSequentially(v, { delay: slow }); else await el.fill(v); };
  await type('[name=company]', 'Your Agency');
  await type('[name=licence]', '51 824 753 556');
  await type('[name=website]', website);
  await type('[name=email]', email);
}

async function walk(browser, { name, viewport, email, website, expect, hintHas, noteHas, shots = true }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|posthog|tiles|maplibre|WebGL/i.test(m.text())) errors.push(m.text()); });
  const shot = async step => { if (shots) await page.screenshot({ path: join(SHOTS, `${name}-${step}.png`), fullPage: viewport.width < 500 }); };
  const noHScroll = async step => check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal scroll at ${step}`);

  await page.goto(CLAIM, { waitUntil: 'networkidle' });
  check(await page.locator('#walk').evaluate(v => !v.paused || v.autoplay), `${name}: walkthrough video is playing on arrival`);
  check(await page.locator('#explainer').isVisible(), `${name}: explainer video sits next to the main button`);
  check((await page.locator('#h-intro').textContent()).includes('own or market this property'), `${name}: the question is the headline`);
  await shot('1-intro'); await noHScroll('intro');

  await page.click('#yes');
  await page.waitForSelector('#s-mode:not([hidden])');
  await page.waitForTimeout(1100); // first-visit hint settles on guest
  await shot('2-mode');
  await page.locator('.mode[data-mode=signup]').click();
  check(await page.locator('#signupBox').isVisible(), `${name}: sign up reveals the email field`);
  check((await page.locator('#modePreview').textContent()).includes('email'), `${name}: mode switch shows what it means`);
  await shot('2b-mode-signup');
  await page.locator('.mode[data-mode=guest]').click();
  check(await page.locator('#signupBox').isHidden(), `${name}: guest needs no account field`);
  await page.click('#modeNext');
  await page.waitForSelector('#s-details:not([hidden])');
  await noHScroll('details');

  await page.click('#submit');
  check(await page.locator('.ferr[data-for=company]').textContent() !== '', `${name}: empty submit names the missing fields`);
  await fillDetails(page, { email, website });
  await page.setInputFiles('[name=file]', { name: 'authority-to-market.pdf', mimeType: 'application/pdf', buffer: pdf });
  const hint = await page.locator('#match').textContent();
  check(hint.includes(hintHas) && !/instantly/.test(hint), `${name}: live domain hint (“${hint.trim()}”), never promises instant verification`);
  await shot('3-details');
  await page.click('#submit');
  await page.waitForSelector('#s-done:not([hidden])', { timeout: 15000 });
  const status = await page.locator('#status').getAttribute('class');
  check(status.includes(expect), `${name}: status is ${expect}`);
  const note = await page.locator('#statusNote').textContent();
  check(note.includes(noteHas), `${name}: status line (“${note.trim()}”)`);
  check(await page.locator('#confirmBox').isHidden(), `${name}: no code box while email sending is off`);
  const share = 'https://' + (await page.locator('#shareUrl').textContent()).trim();
  check(/\/s\/arncliffe-central\/[a-z2-9]{6}$/.test(share), `${name}: share link ${share}`);
  check(await page.locator('#manageBox').isVisible(), `${name}: guest gets a private manage link`);
  await page.click('#copyShare');
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check(clip === share, `${name}: Copy link puts the share link on the clipboard`);
  await page.waitForTimeout(250);
  await shot('4-done'); await noHScroll('done');

  // returning visitor (cookie) lands on the payoff, not the form
  await page.goto(CLAIM, { waitUntil: 'networkidle' });
  check(await page.locator('#s-done').isVisible(), `${name}: returning claimant sees their link`);

  // manage link in a fresh browser
  const manage = (await page.locator('#manageUrl').textContent().catch(() => '')) || '';
  const ctx2 = await browser.newContext({ viewport });
  const p2 = await ctx2.newPage();
  const token = (await ctx.cookies()).find(c => c.name === 'sh_claim');
  check(!!token && token.httpOnly, `${name}: claim token cookie is HttpOnly`);
  await ctx2.close();

  // the public page behind the share link
  const pub = await browser.newPage({ viewport });
  const local = share.replace(/^https?:\/\/[^/]+/, BASE);
  await pub.goto(local, { waitUntil: 'domcontentloaded' });
  await pub.waitForFunction(() => document.getElementById('pname').textContent !== 'Loading…', null, { timeout: 30000 }).catch(() => {});
  await pub.waitForTimeout(1500);
  const by = await pub.locator('#pby').isVisible() ? await pub.locator('#pby').textContent() : '';
  check(expect === 'verified' ? by === 'Marketed by Your Agency' : by === '', `${name}: public page branding ${by ? '“' + by + '”' : 'hidden'} (${expect})`);
  if (shots) await pub.screenshot({ path: join(SHOTS, `${name}-5-share-link.png`) });
  await pub.close();
  check(!errors.length, `${name}: no page errors ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
  return { share, manage };
}

async function explainer(browser) {
  const S = 660, dir = join(tmpdir(), 'showhaus-claim-rec'); // ?rec=1 zooms the page 1.5× (a 440 px phone layout): legible as a small thumbnail
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: S, height: S }, permissions: ['clipboard-read', 'clipboard-write'], recordVideo: { dir, size: { width: S, height: S } } });
  const page = await ctx.newPage();
  // A visible pointer for the recording only (headless video has no cursor).
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;z-index:99;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(196,98,45,.35);border:2px solid #c4622d;pointer-events:none;transition:left .35s ease,top .35s ease,transform .12s;left:-40px;top:-40px';
    document.documentElement.appendChild(d); // outside the zoomed body, so viewport coordinates apply
    window.__ptr = (x, y, click) => { d.style.left = x + 'px'; d.style.top = y + 'px'; if (click) { d.style.transform = 'scale(.7)'; setTimeout(() => { d.style.transform = ''; }, 140); } };
  }));
  const point = async (sel, click = true) => {
    const b = await page.locator(sel).first().boundingBox();
    await page.evaluate(([x, y]) => window.__ptr(x, y, false), [b.x + b.width / 2, b.y + b.height / 2]);
    await page.waitForTimeout(380);
    if (click) { await page.evaluate(([x, y]) => window.__ptr(x, y, true), [b.x + b.width / 2, b.y + b.height / 2]); await page.locator(sel).first().click(); }
  };
  const t0 = Date.now(), marks = {};
  await page.goto(`${CLAIM}&rec=1`, { waitUntil: 'networkidle' });
  marks.start = (Date.now() - t0) / 1000;
  await page.waitForTimeout(1300);
  await point('#yes');
  await page.waitForTimeout(900);
  await point('.mode[data-mode=guest]');
  await page.waitForTimeout(400);
  await point('#modeNext');
  await page.waitForTimeout(500);
  await point('.roles label:has-text("Listing agent")');
  for (const [sel, v] of [['[name=company]', 'Your Agency'], ['[name=licence]', '51 824 753 556'], ['[name=website]', 'youragency.com.au'], ['[name=email]', 'you@youragency.com.au']]) {
    await point(sel); await page.locator(sel).pressSequentially(v, { delay: 28 });
  }
  await page.setInputFiles('[name=file]', { name: 'authority-to-market.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForTimeout(700);
  await point('#submit');
  await page.waitForSelector('#s-done:not([hidden])');
  await page.waitForTimeout(700);
  await point('#copyShare');
  await page.waitForTimeout(1800);
  marks.end = (Date.now() - t0) / 1000;
  await page.screenshot({ path: join(dir, 'done.png') });
  await ctx.close();
  const webm = join(dir, (await readdir(dir)).find(f => f.endsWith('.webm')));
  const dur = marks.end - marks.start, speed = Math.max(1, dur / 10);
  console.log(`recorded ${dur.toFixed(1)} s → ×${speed.toFixed(2)} → 10 s`);
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
  const vf = `trim=start=${marks.start.toFixed(2)}:end=${marks.end.toFixed(2)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},fps=24,scale=${S}:${S}`;
  ff('-i', webm, '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(MEDIA, 'claim-explainer.mp4'));
  ff('-i', webm, '-an', '-vf', vf, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-row-mt', '1', join(MEDIA, 'claim-explainer.webm'));
  ff('-sseof', '-0.6', '-i', join(MEDIA, 'claim-explainer.mp4'), '-frames:v', '1', '-q:v', '3', join(MEDIA, 'claim-explainer-poster.jpg'));
  for (const f of ['claim-explainer.mp4', 'claim-explainer.webm', 'claim-explainer-poster.jpg']) {
    const b = (await stat(join(MEDIA, f))).size; console.log(`${f}: ${(b / 1024).toFixed(0)} KB`);
    if (!f.endsWith('.jpg')) check(b <= 1.5 * 1024 * 1024, `${f} ≤ 1.5 MB`);
  }
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', join(MEDIA, 'claim-explainer.mp4')]).toString());
  check(Math.abs(Number(probe.format.duration) - 10) < 1.2, `explainer is ~10 s (${Number(probe.format.duration).toFixed(1)} s)`);
  await writeFile(join(MEDIA, 'claim-explainer.json'), JSON.stringify({ recorded: new Date().toISOString(), base: BASE, size: [S, S], real_seconds: +dur.toFixed(1), speed: +speed.toFixed(2), duration_s: Number(probe.format.duration) }, null, 1));
}

// Email kit: a 300×300 explainer poster with a play mark (hosted, linked to the video), then previews of the draft email
// rendered with the hosted image URLs pointed at the local dist files.
async function email(browser) {
  const kit = fileURLToPath(new URL('../showhaus/outreach/claim-arncliffe-central/', import.meta.url));
  const poster = (await readFile(join(MEDIA, 'claim-explainer-poster.jpg'))).toString('base64');
  const pg = await browser.newPage({ viewport: { width: 300, height: 300 } });
  await pg.setContent(`<body style="margin:0"><div style="position:relative;width:300px;height:300px;background:url(data:image/jpeg;base64,${poster}) center/cover">
    <div style="position:absolute;inset:0;background:rgba(29,39,51,.18)"></div>
    <div style="position:absolute;left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px;border-radius:50%;background:#c4622d;box-shadow:0 6px 18px rgba(0,0,0,.25)">
      <div style="position:absolute;left:30px;top:22px;border-left:26px solid #fff8ee;border-top:16px solid transparent;border-bottom:16px solid transparent"></div></div></div></body>`);
  await pg.screenshot({ path: join(MEDIA, 'claim-explainer-email.jpg'), type: 'jpeg', quality: 82 });
  await pg.close();
  const html = (await readFile(join(kit, 'email.html'), 'utf8')).replaceAll('https://showhaus.app/claim/media/', new URL('../dist/showhaus/claim/media/', import.meta.url).href)
    .replaceAll('{{first_name}}', 'Sam');
  await writeFile(join(tmpdir(), 'showhaus-claim-email.html'), html);
  for (const [name, width] of [['preview.png', 760], ['preview-mobile.png', 390]]) {
    const p = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: width < 500 ? 2 : 1 });
    await p.goto('file://' + join(tmpdir(), 'showhaus-claim-email.html'), { waitUntil: 'load' });
    await p.screenshot({ path: join(kit, name), fullPage: true });
    check(await p.evaluate(() => [...document.images].every(i => i.complete && i.naturalWidth > 0)), `email ${name}: every image loads`);
    const text = await p.evaluate(() => document.body.innerText);
    check(!/@gmail|Ji\b|Kim\b/.test(text) && text.includes('SHOWHAUS Studio'), `email ${name}: signed SHOWHAUS Studio only`);
    await p.close();
  }
}

const browser = await chromium.launch();
await mkdir(SHOTS, { recursive: true });
if (process.argv.includes('--explainer')) await explainer(browser);
else if (process.argv.includes('--email')) await email(browser);
else {
  const stamp = Date.now().toString(36);
  // Without a confirmed mailbox (no emailed code) nothing is verified: domain match => pending "we'll confirm by email".
  const match = { expect: 'pending', hintHas: 'Domains match', noteHas: 'Domain matches' };
  const other = { expect: 'pending', noteHas: 'once verified' };
  await walk(browser, { name: 'desktop-domain-match', viewport: { width: 1440, height: 900 }, email: `judge.a.${stamp}@youragency.com.au`, website: 'https://www.youragency.com.au', ...match });
  await walk(browser, { name: 'mobile-domain-match', viewport: { width: 390, height: 844 }, email: `judge.b.${stamp}@youragency.com.au`, website: 'youragency.com.au', ...match });
  await walk(browser, { name: 'mobile-pending', viewport: { width: 390, height: 844 }, email: `judge.c.${stamp}@gmail.com`, website: 'youragency.com.au', ...other, hintHas: 'Personal email' });
  await walk(browser, { name: 'desktop-pending', viewport: { width: 1440, height: 900 }, email: `judge.d.${stamp}@youragency-group.com.au`, website: 'youragency.com.au', ...other, hintHas: 'Domains differ' });
  console.log(`screenshots: ${SHOTS}`);
}
await browser.close();
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exitCode = 1; }
