// SHOWHAUS Room fault check: the model host answers 429. A short outage must recover on its own; a long one must say
// the host is busy (not "your browser") and offer Try again, which then works.
// node scripts/showhaus-room-fault.mjs --base http://localhost:8811
const base = process.argv[process.argv.indexOf('--base') + 1] || 'http://localhost:8811';
const { chromium } = await import(process.env.PW || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
async function run(fail) { // fail(n) → true to answer the n-th hub request with 429
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  let n = 0; await page.route(/huggingface\.co\//, r => fail(++n) ? r.fulfill({ status: 429, body: 'Too Many Requests' }) : r.continue());
  await page.goto(base + '/room/?synthetic=1'); await page.click('#sample');
  return page;
}
const done = p => p.waitForFunction(() => ['ready', 'reveal', 'error'].includes(window.__room.phase()), null, { timeout: 600000 }).then(() => p.evaluate(() => window.__room.phase()));

let p = await run(n => n <= 3);                     // a blip: the first three hub requests fail
let sawWait = false; p.on('console', () => {}); const t = setInterval(async () => { try { if (/busy\. Trying again/.test(await p.textContent('#status'))) sawWait = true; } catch {} }, 500);
ok(await done(p) !== 'error', 'a short 429 blip recovers by itself'); clearInterval(t); ok(sawWait, 'the wait is explained while it happens');
await p.close();

let down = true; p = await run(() => down);         // the hub stays busy until "later"
ok(await done(p) === 'error', 'a long outage ends in an error');
const msg = await p.textContent('#status'); ok(/model host is busy/.test(msg) && !/browser/.test(msg), 'it blames the host, not the browser: ' + msg);
ok(await p.isVisible('#retryScan'), 'Try again is offered');
down = false; await p.click('#retryScan'); await p.waitForTimeout(1500); // phase still reads 'error' for a moment after the click const ph = await done(p); ok(ph !== 'error', 'Try again works once the host answers: ' + await p.textContent('#status'));
await browser.close();
