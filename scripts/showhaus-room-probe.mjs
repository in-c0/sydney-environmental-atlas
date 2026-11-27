// SHOWHAUS Room probe: scan any photo with the real in-browser models and tap the middle of every detected thing,
// recording what the sheet says (name, size, sizes offered, hint). Finds the cases the fixed judge photo never shows.
// node scripts/showhaus-room-probe.mjs --base http://localhost:8811 --photo a.jpg [--photo b.jpg] [--phone] [--shots dir]
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
const args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const photos = args.flatMap((a, i) => a === '--photo' ? [args[i + 1]] : []);
const base = arg('--base') || 'http://localhost:8811', shots = arg('--shots') || '/tmp/room-probe', phone = args.includes('--phone');
const { chromium } = await import(process.env.PW || 'playwright');
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true } : { viewport: { width: 1360, height: 860 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
const report = [];
for (const photo of photos) {
  const name = basename(photo).replace(/\.\w+$/, '');
  await page.goto(base + '/room/?synthetic=1');
  await page.setInputFiles('#file', photo);
  await page.waitForFunction(() => ['ready', 'reveal', 'error'].includes(window.__room.phase()), null, { timeout: 600000 });
  await page.waitForTimeout(1200); await page.screenshot({ path: `${shots}/${name}-scan.png` });
  const boxes = await page.evaluate(() => window.__room.boxes()), size = await page.evaluate(() => window.__room.size()), hb = await page.locator('#hud').boundingBox();
  const row = { photo: name, boxes: boxes.map(b => `${b.label} ${b.score.toFixed(2)}`), taps: [] };
  for (const [k, b] of boxes.slice(0, 6).entries()) {
    const cx = (b.box.xmin + b.box.xmax) / 2, cy = (b.box.ymin + b.box.ymax) / 2;
    await page.mouse.click(hb.x + cx / size[0] * hb.width, hb.y + cy / size[1] * hb.height);
    const opened = await page.waitForSelector('#sheet:not([hidden])', { timeout: 120000 }).then(() => true, () => false);
    const t = { tapped: b.label, opened };
    if (opened) {
      Object.assign(t, await page.evaluate(() => ({ name: document.querySelector('#objName').value, w: +document.querySelector('#dw').value, d: +document.querySelector('#dd').value,
        h: +document.querySelector('#dh').value, levels: !document.querySelector('#levels').hidden, hint: document.querySelector('#sheetHint').textContent,
        dimNote: document.querySelector('#dimNote').textContent, kindNote: document.querySelector('#kindNote').textContent })), { px: (await page.evaluate(() => window.__room.sel()))?.px });
      await page.waitForTimeout(600); await page.screenshot({ path: `${shots}/${name}-tap${k}-${b.label.replace(/\W+/g, '_')}.png` });
      await page.click('#again');
    } else t.status = await page.textContent('#status');
    row.taps.push(t);
  }
  report.push(row);
}
console.log(JSON.stringify({ report, errors: errs }, null, 1));
await browser.close();
