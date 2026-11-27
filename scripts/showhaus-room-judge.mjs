// SHOWHAUS Room click-through in real Chromium with the real in-browser models:
// scan the sample photo → pick the sofa → keep it → tape room → place → say three changes → reopen step 2 → photo room.
// node scripts/showhaus-room-judge.mjs --base http://localhost:8811 [--shots dir] [--phone]
import { mkdirSync } from 'node:fs';
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const base = arg('--base') || 'http://localhost:8811', shots = arg('--shots') || '/tmp/room-shots', phone = process.argv.includes('--phone');
const { chromium } = await import(process.env.PW || 'playwright').catch(() => import('playwright-core'));
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true } : { viewport: { width: 1360, height: 860 } });
const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errs.push(m.text()); });
const ok = (c, msg) => { if (!c) { console.error('FAIL', msg, errs.slice(-5)); process.exitCode = 1; } else console.log('ok', msg); };
const st = () => page.evaluate(() => window.__room.state());
const tag = phone ? 'phone' : 'desk';
await page.goto(base + '/room/?synthetic=1');
await page.click('#sample');
await page.waitForFunction(() => ['ready', 'reveal', 'error'].includes(window.__room.phase()), null, { timeout: 600000 });
ok(await page.evaluate(() => window.__room.phase()) !== 'error', 'models load and the photo is scanned: ' + await page.textContent('#status'));
await page.waitForTimeout(1500); await page.screenshot({ path: `${shots}/${tag}-1-scan.png` });
const boxes = await page.evaluate(() => window.__room.boxes()), size = await page.evaluate(() => window.__room.size());
console.log('boxes', boxes.map(b => b.label + ' ' + b.score.toFixed(2)).join(', '));
const sofa = boxes.find(b => b.label === 'couch'); ok(sofa, 'the sofa is found');
const hb = await page.locator('#hud').boundingBox(), cx = 300, cy = 560; // on the sofa's seat (the box centre is the rug between its arms)
await page.mouse.click(hb.x + cx / size[0] * hb.width, hb.y + cy / size[1] * hb.height);
await page.waitForSelector('#sheet:not([hidden])', { timeout: 120000 });
ok(await page.inputValue('#objName') === 'Sofa', 'named Sofa'); ok(+await page.inputValue('#dw') === 2 && +await page.inputValue('#dh') < 1.2, 'size from the sofa prior: 2.0 m wide, sofa height');
ok((await page.textContent('#sheetHint')).length > 10, 'the tap hint is inside the sheet, not hidden under it');
if (!(await page.locator('#levels').isHidden())) { // SAM offered more than one size: stepping changes the cut-out and comes back
  const pa = (await page.evaluate(() => window.__room.sel())).px, dirBtn = (await page.locator('#lvSmaller').isDisabled()) ? '#lvBigger' : '#lvSmaller', back = dirBtn === '#lvBigger' ? '#lvSmaller' : '#lvBigger';
  await page.click(dirBtn); const pb = (await page.evaluate(() => window.__room.sel())).px; ok(pa.join() !== pb.join(), `Smaller/Bigger changes the cut-out: ${pa} → ${pb}`);
  await page.click(back); ok(await page.inputValue('#objName') === 'Sofa', 'stepping back is the sofa again');
} else console.log('one size only for this tap');
// steer the cut-out: tap the coffee table (outside → added), then tap it again (inside → taken out)
const px0 = (await page.evaluate(() => window.__room.sel())).px;
const steer = async (x, y) => { const b = await page.locator('#hud').boundingBox(); await page.mouse.click(b.x + x / size[0] * b.width, b.y + y / size[1] * b.height);
  await page.waitForFunction(() => /keep steering|nothing|Could not/.test(document.getElementById('status').textContent), null, { timeout: 120000 }); return (await page.evaluate(() => window.__room.sel())).px; };
const px1 = await steer(576, 499); ok(px1[0] * px1[1] > px0[0] * px0[1], `a tap outside adds that part: ${px0} → ${px1}`);
const px2 = await steer(576, 499); ok(px2[0] * px2[1] < px1[0] * px1[1], `a tap inside takes it out again: ${px1} → ${px2}`);
await page.fill('#dw', '2.2'); await page.dispatchEvent('#dw', 'input');
await page.waitForTimeout(800); await page.screenshot({ path: `${shots}/${tag}-2-cut.png` });
await page.click('#keep'); await page.waitForFunction(() => window.__room.state().objects === 1);
// a tap on the wall is not a thing; a tap on the coffee table (no detector label, inside the sofa's box) is the table
const tapAt = async (x, y) => { const b = await page.locator('#hud').boundingBox(); await page.mouse.click(b.x + x / size[0] * b.width, b.y + y / size[1] * b.height);
  await page.waitForFunction(() => !/Cutting/.test(document.getElementById('status').textContent), null, { timeout: 120000 }); };
await tapAt(746, 159); ok(/wall, floor or ceiling/.test(await page.textContent('#status')), 'a tap on the wall is refused, not kept as a thing');
await tapAt(576, 499); await page.waitForSelector('#sheet:not([hidden])');
const t = await page.evaluate(() => window.__room.sel()); ok(t.label === null && t.px[0] < 300, 'the coffee table is cut out on its own: ' + JSON.stringify(t));
await page.fill('#objName', 'coffee table'); ok(+await page.inputValue('#dh') === 0.42, 'typing "coffee table" sizes it like one');
await page.click('#again');
await page.click('#tabRoom'); await page.click('#tapeForm button');
await page.waitForSelector('#tray button[data-id]'); await page.click('#tray button[data-id]');
let s = await st(); ok(s.items.length === 1 && s.space === 'tape', 'sofa placed in the tape room');
const fitText = await page.textContent('#fit'); ok(/ · Fits/.test(fitText), 'a fit verdict shows for the placed sofa: ' + fitText);
const x0 = s.items[0].x, s0 = s.items[0];
for (const t of ['sofa 50cm left', '벽지 세이지 줄무늬', 'night']) { await page.fill('#sayIn', t); await page.press('#sayIn', 'Enter'); await page.waitForTimeout(300); }
s = await st(); ok(Math.abs(Math.hypot(s.items[0].x - x0, s.items[0].y - s0.y) - 0.5) < 0.05, 'sofa moved 50 cm'); ok(s.wall.colour === 'sage' && s.wall.pattern === 'stripes', 'walls sage stripes'); ok(s.sun === false, 'night');
ok(s.steps === 5, 'five steps on the timeline: ' + s.steps);
await page.waitForTimeout(800); await page.screenshot({ path: `${shots}/${tag}-3-room-night.png` });
await page.click('#viewBtn'); await page.fill('#sayIn', 'day'); await page.press('#sayIn', 'Enter'); await page.waitForTimeout(600); await page.screenshot({ path: `${shots}/${tag}-3b-eye.png` }); await page.click('#viewBtn');
await page.click('#timeline button[data-k="1"]'); await page.waitForTimeout(500); s = await st();
ok(s.cur === 1 && s.sun === true && s.wall.colour === null, 'tapping step 2 reopens the room as it was');
await page.screenshot({ path: `${shots}/${tag}-4-rewind.png` });
await page.fill('#sayIn', 'lights off'); await page.press('#sayIn', 'Enter'); s = await st(); ok(s.steps === 2 || s.steps === 3, 'a new change from step 2 branches: ' + s.steps);
await page.click('#newSpace'); await page.click('#planList button[data-sample]'); await page.waitForTimeout(1500); s = await st();
ok(s.space === 'photo' && s.items.length === 1, 'same sofa in the room photo');
await page.screenshot({ path: `${shots}/${tag}-5-photo.png` });
ok(!errs.length, 'no page errors ' + errs.join(' | '));
await browser.close();
