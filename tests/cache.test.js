const test = require('node:test');
const assert = require('node:assert');

const { createCache } = require('../server/cache');

test('set 后 get 命中，统计 hits 累加', () => {
  const cache = createCache();
  cache.set('k', { v: 1 });
  assert.deepStrictEqual(cache.get('k'), { v: 1 });
  assert.deepStrictEqual(cache.get('k'), { v: 1 });
  assert.strictEqual(cache.stats().hits, 2);
});

test('未 set 的键返回 undefined 且 misses 累加', () => {
  const cache = createCache();
  assert.strictEqual(cache.get('nope'), undefined);
  assert.strictEqual(cache.stats().misses, 1);
});

test('超过 TTL 后失效（默认 600 秒）', () => {
  let now = 1000;
  const cache = createCache({ ttlSeconds: 600, now: () => now });
  cache.set('k', 'v');
  now = 1000 + 599 * 1000;
  assert.strictEqual(cache.get('k'), 'v');
  now = 1000 + 601 * 1000;
  assert.strictEqual(cache.get('k'), undefined);
});

test('stats 返回 size/hits/misses/sets', () => {
  const cache = createCache();
  cache.set('a', 1);
  cache.get('a');
  cache.get('b');
  const s = cache.stats();
  assert.strictEqual(s.size, 1);
  assert.strictEqual(s.hits, 1);
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.sets, 1);
});
