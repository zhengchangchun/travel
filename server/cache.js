const DEFAULT_TTL_SECONDS = 600;

function createCache({ ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let sets = 0;

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      misses += 1;
      return undefined;
    }
    if (now() - entry.at > ttlSeconds * 1000) {
      store.delete(key);
      misses += 1;
      return undefined;
    }
    hits += 1;
    return entry.value;
  }

  function set(key, value) {
    store.set(key, { value, at: now() });
    sets += 1;
  }

  function stats() {
    return { size: store.size, hits, misses, sets, ttlSeconds };
  }

  function clear() {
    store.clear();
  }

  return { get, set, stats, clear };
}

module.exports = { createCache, DEFAULT_TTL_SECONDS };
