// SHOWHAUS — click-through judge for the no-login inputs (Playwright, desktop + 390 px): suggest a home on the gallery,
// report a mistake in the viewer.   node scripts/showhaus-suggest-judge.mjs   (starts scripts/showhaus-local-worker.mjs)
const { serve, env } = await import('./showhaus-local-worker.mjs');
// The NSW address register stands in locally (the judge runs offline): prefix matches with map points.
const REG = [['199 FOREST ROAD ARNCLIFFE', 151.134659, -33.941236], ['199 FOREST ROAD KIRRAWEE', 151.077778, -34.040384], ['199 FOREST ROAD HURSTVILLE', 151.103826, -33.967638]];
env.__fetch = async u => { const w = new URL(u).searchParams.get('where'); const m = w.match(/^address (LIKE|=) '(.*)'$/); const v = m[2].replace(/%$/, '');
  return new Response(JSON.stringify({ features: REG.filter(([a]) => m[1] === '=' ? a === v : a.startsWith(v)).map(([a, x, y]) => ({ attributes: { address: a }, geometry: { x, y } })) })); };
const server = await serve(8797); const BASE = 'http://127.0.0.1:8797/showhaus';
const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const fails = []; const check = (ok, m) => { console.log((ok ? 'ok   ' : 'FAIL ') + m); if (!ok) fails.push(m); };
for (const [name, vp, touch] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 780 }, true]]) {
  const ctx = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/walk/?synthetic=1'); await p.waitForSelector('#suggest');
  await p.fill('#sgUrl', 'hello'); await p.click('#sgBtn');
  check((await p.textContent('#sgNote')).includes('Start with the house number'), name + ': text that is neither an address nor a link is refused with a plain reason');
  await p.fill('#sgUrl', ''); await p.type('#sgUrl', '199 forest rd', { delay: 40 });
  await p.waitForSelector('#sgList:not([hidden]) li');
  const opts = await p.$$eval('#sgList li', l => l.map(x => x.textContent));
  check(opts.length === 3 && opts[0].includes('199 Forest Road, Arncliffe NSW'), name + ': typing an address lists NSW register matches: ' + opts.join(' | '));
  await p.waitForTimeout(500); await p.screenshot({ path: `/tmp/showhaus-suggest-${name}-address.png` });
  if (touch) await p.tap('#sgList li >> nth=0'); else { await p.press('#sgUrl', 'ArrowDown'); await p.press('#sgUrl', 'Enter'); }
  check(await p.inputValue('#sgUrl') === '199 Forest Road, Arncliffe NSW' && await p.isHidden('#sgList'), name + ': picking a match fills the box and closes the list');
  await p.click('#sgBtn'); await p.waitForFunction(() => /Counted/.test(document.getElementById('sgNote').textContent));
  check((await p.textContent('#sgNote')).includes('199 Forest Road, Arncliffe NSW'), name + ': the address is counted without sign-up: ' + await p.textContent('#sgNote'));
  await p.evaluate(() => { document.getElementById('sgNote').textContent = ''; });
  await p.fill('#sgUrl', 'https://www.buildtec.com.au/home-designs/avalon/?utm_source=fb'); if (touch) await p.fill('#sgEmail', 'pat@example.com'); await p.click('#sgBtn');
  await p.waitForFunction(() => /Counted/.test(document.getElementById('sgNote').textContent));
  check(true, name + ': a plan link is counted without sign-up: ' + (await p.textContent('#sgNote')));
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': gallery has no sideways scroll');
  await p.locator('#suggest').scrollIntoViewIfNeeded(); await p.screenshot({ path: `/tmp/showhaus-suggest-${name}-gallery.png` });
  await p.goto(BASE + '/walk/?p=buildtec-avalon&synthetic=1'); await p.waitForSelector('#title:not([hidden])', { timeout: 120000 });
  await p.click('#fixOpen'); await p.waitForSelector('#fix:not([hidden])');
  const before = await p.evaluate(() => JSON.stringify(window.__sh.state()));
  await p.selectOption('#fixRoom', { index: 1 }); await p.fill('#fixNote', 'the island is on the wrong side'); await p.press('#fixNote', 'w', { timeout: 90000 }); await p.press('#fixNote', 'd', { timeout: 90000 });
  check(before === await p.evaluate(() => JSON.stringify(window.__sh.state())), name + ': typing a report does not move the camera');
  await p.click('#fixSend'); await p.waitForFunction(() => /Sent/.test(document.getElementById('fixOpen').textContent) && document.getElementById('fix').hidden);
  check(true, name + ': the report is sent');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': viewer has no sideways scroll');
  await p.screenshot({ path: `/tmp/showhaus-suggest-${name}-fix.png` });
  check(!errs.length, name + ': no page errors ' + errs.join('|'));
  await ctx.close();
}
const d = env.OPS_DB._db;
check(d.prepare("SELECT votes FROM sh_suggest WHERE host != 'address'").get().votes === 2, 'two visitors, one link, two votes');
check(d.prepare("SELECT votes FROM sh_suggest WHERE k = 'addr:199 FOREST ROAD ARNCLIFFE'").get().votes === 2, 'two visitors, one address, two votes');
check(d.prepare("SELECT verified FROM sh_suggest_geo WHERE k = 'addr:199 FOREST ROAD ARNCLIFFE'").get().verified === 1, 'the picked address carries its register map point');
check(d.prepare('SELECT COUNT(*) n FROM sh_suggest_notify').get().n === 1, 'the optional email is kept for one visitor only');
check(d.prepare('SELECT COUNT(*) n FROM sh_fixes').get().n === 2 && d.prepare("SELECT COUNT(*) n FROM sh_fixes WHERE env != 'synthetic'").get().n === 0, 'reports stored, marked synthetic');
await b.close(); server.close && server.close(); console.log(fails.length ? fails.length + ' FAILED' : 'all passed'); process.exit(fails.length ? 1 : 0);
