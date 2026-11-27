// Every file the Worker serves must stay under the Workers static-asset limit (25 MiB per file), or the whole
// deploy fails (27 Nov: a 32 MB APK in dist/showhaus/app/ blocked every page's deploy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const LIMIT = 25 * 1024 * 1024;
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
test('no served file is over 25 MiB', () => {
  const big = walk(new URL('../dist', import.meta.url).pathname).filter(f => statSync(f).size > LIMIT).map(f => `${f} ${(statSync(f).size / 2 ** 20).toFixed(1)} MiB`);
  assert.deepEqual(big, []);
});
