import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewrite } from '../src/worker.js';
test('atlas hosts pass through untouched', () => {
  assert.equal(rewrite('https://map.lifeos.studio/'), null);
  assert.equal(rewrite('https://map.lifeos.studio/showhaus/app.js'), null);
  assert.equal(rewrite('https://sydney-environmental-atlas.wldud5192.workers.dev/data/manifest.json'), null);
});
test('showhaus.app serves the app at the root', () => {
  assert.deepEqual(rewrite('https://showhaus.app/'), { asset: 'https://showhaus.app/showhaus/' });
  assert.deepEqual(rewrite('https://showhaus.app/app.js'), { asset: 'https://showhaus.app/showhaus/app.js' });
  assert.deepEqual(rewrite('https://showhaus.app/data/rents.json?v=1'), { asset: 'https://showhaus.app/showhaus/data/rents.json?v=1' });
  assert.deepEqual(rewrite('https://showhaus.app/showhaus/app.js'), { redirect: 'https://showhaus.app/app.js' });
  assert.deepEqual(rewrite('https://www.showhaus.app/x'), { redirect: 'https://showhaus.app/x' });
});
