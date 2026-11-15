import test from 'node:test';
import assert from 'node:assert/strict';
import { lane, job } from './showhaus-photoreal-queue.mjs';

const gallery = [{ slug: 'a', kind: 'walk' }, { slug: 'b', kind: 'walk' }, { slug: 'c', kind: 'walk' }, { slug: 's', kind: 'studio' }];
const rooms = slug => ({
  a: { views: [{ name: 'K' }, { name: 'P', photo: 'photo1.jpg' }] },
  b: { views: [{ name: 'Living' }, { name: 'Dining' }] },
  c: { views: [{ name: 'Kitchen' }] },
}[slug] || null);

test('follows vote order, skips done homes, takes the first one without photos', () => {
  const { rows, next } = lane({ photoreal: [{ slug: 'a', votes: 9 }, { slug: 'b', votes: 4 }, { slug: 'c', votes: 2 }] }, { rooms, gallery });
  assert.deepEqual(rows.map(r => r.state), ['done', 'next', 'waiting']);
  assert.equal(next.slug, 'b');
  assert.deepEqual(next.views, ['Living', 'Dining']);
});

test('homes not in the gallery (private, studio, removed) never become a job', () => {
  const { rows, next } = lane({ photoreal: [{ slug: 'gone', votes: 5 }, { slug: 's', votes: 4 }, { slug: 'c', votes: 1 }] }, { rooms, gallery });
  assert.deepEqual(rows.map(r => r.state), ['skipped', 'skipped', 'next']);
  assert.equal(next.slug, 'c');
});

test('no votes means no job', () => {
  const { rows, next } = lane({ queue: { photoreal: [] } }, { rooms, gallery });
  assert.equal(rows.length, 0); assert.equal(next, null); assert.equal(job(next), null);
});

test('job manifest carries slug, votes and the views to make photoreal', () => {
  const j = job({ slug: 'b', votes: 4, views: ['Living'] }, 'T');
  assert.equal(j.slug, 'b'); assert.equal(j.at, 'T'); assert.deepEqual(j.views, ['Living']); assert.ok(j.steps.length >= 3);
});
