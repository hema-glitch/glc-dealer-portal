/**
 * Shared cache helper.
 *
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * are configured. Falls back to memory plus the existing Vercel-safe /tmp file
 * for local development or deployments without Redis.
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = process.env.VERCEL
  ? '/tmp/.glc-cache.json'
  : path.join(__dirname, '../../.cache.json');

const NAMESPACE = process.env.CACHE_NAMESPACE
  || `glc-dealer-portal:${process.env.ZOHO_ORG_ID || 'default'}`;

const memory = new Map();
const inflight = new Map();
let redisClient = null;
let redisUnavailable = false;

function namespaced(key) {
  return `${NAMESPACE}:${key}`;
}

function unnamespaced(key) {
  const prefix = `${NAMESPACE}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function getRedis() {
  if (redisUnavailable) return null;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  if (redisClient) return redisClient;

  try {
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return redisClient;
  } catch (err) {
    redisUnavailable = true;
    console.warn('[Cache] Redis unavailable, using local fallback:', err.message);
    return null;
  }
}

function readFileCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeFileCache(store) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store));
  } catch {}
}

function getMemory(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memory.delete(key);
    return null;
  }
  return entry.data;
}

async function getCache(key) {
  const redis = getRedis();
  if (redis) {
    try {
      const value = await redis.get(namespaced(key));
      if (value !== null && value !== undefined) return value;
    } catch (err) {
      console.warn('[Cache] Redis get failed, using local fallback:', err.message);
    }
  }

  const mem = getMemory(key);
  if (mem !== null && mem !== undefined) return mem;

  const entry = readFileCache()[key];
  if (!entry || Date.now() > (entry.x || 0)) return null;
  memory.set(key, { data: entry.d, expiresAt: entry.x });
  return entry.d;
}

async function setCache(key, data, ttlMs) {
  const expiresAt = Date.now() + ttlMs;
  memory.set(key, { data, expiresAt });

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(namespaced(key), data, { ex: Math.max(1, Math.ceil(ttlMs / 1000)) });
      return;
    } catch (err) {
      console.warn('[Cache] Redis set failed, using local fallback:', err.message);
    }
  }

  const store = readFileCache();
  store[key] = { d: data, x: expiresAt };
  writeFileCache(store);
}

async function deleteCache(key) {
  memory.delete(key);

  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(namespaced(key));
    } catch (err) {
      console.warn('[Cache] Redis del failed:', err.message);
    }
  }

  const store = readFileCache();
  if (key in store) {
    delete store[key];
    writeFileCache(store);
  }
}

async function deletePrefix(prefix) {
  for (const key of Array.from(memory.keys())) {
    if (key.startsWith(prefix)) memory.delete(key);
  }

  const redis = getRedis();
  if (redis) {
    try {
      const keys = await redis.keys(namespaced(`${prefix}*`));
      if (keys.length) await redis.del(...keys);
    } catch (err) {
      console.warn('[Cache] Redis prefix delete failed:', err.message);
    }
  }

  const store = readFileCache();
  let changed = false;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeFileCache(store);
}

async function clearAllCache() {
  memory.clear();

  const redis = getRedis();
  if (redis) {
    try {
      const keys = await redis.keys(namespaced('*'));
      if (keys.length) await redis.del(...keys);
    } catch (err) {
      console.warn('[Cache] Redis clear failed:', err.message);
    }
  }

  writeFileCache({});
}

async function remember(key, ttlMs, loader) {
  const cached = await getCache(key);
  if (cached !== null && cached !== undefined) return cached;

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) {
      await setCache(key, fresh, ttlMs);
    }
    return fresh;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

async function getCacheStatus() {
  const redis = getRedis();
  if (redis) {
    try {
      const keys = await redis.keys(namespaced('*'));
      const entries = await Promise.all(keys.map(async (key) => ({
        key: unnamespaced(key),
        backend: 'redis',
        expiresIn: `${await redis.ttl(key)}s`,
      })));
      return { backend: 'redis', cacheEntries: entries.length, entries };
    } catch (err) {
      return { backend: 'redis', error: err.message, cacheEntries: 0, entries: [] };
    }
  }

  const store = readFileCache();
  const now = Date.now();
  const entries = Object.entries(store).map(([key, entry]) => ({
    key,
    backend: 'local',
    expiresIn: `${Math.round(((entry.x || 0) - now) / 1000)}s`,
    expired: now > (entry.x || 0),
  }));
  return { backend: 'local', cacheEntries: entries.length, entries };
}

module.exports = {
  getCache,
  setCache,
  deleteCache,
  deletePrefix,
  clearAllCache,
  remember,
  getCacheStatus,
};
