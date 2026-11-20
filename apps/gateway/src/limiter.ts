import { createHash } from 'node:crypto';
import {
  buildLimiterKey,
  createMemoryStore,
  runMemoryAlgorithm,
  sweepMemoryStore,
  type AlgorithmConfig,
  type LimiterOutcome,
  type RateLimitAlgo,
} from '@aegisgate/shared';
import { Redis } from 'ioredis';

// ---------------------------------------------------------------------------
// Lua scripts (atomic, executed inside Redis)
// ---------------------------------------------------------------------------

export const TOKEN_BUCKET_LUA = `
-- KEYS[1]: bucket key
-- ARGV[1]: rate (tokens per window)
-- ARGV[2]: window_ms
-- ARGV[3]: burst_capacity
-- ARGV[4]: now_ms
-- ARGV[5]: cost_credits
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local data = redis.call('HMGET', key, 'tokens', 'last_updated')
local tokens = tonumber(data[1])
local last_updated = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  last_updated = now
else
  local elapsed = math.max(0, now - last_updated)
  local refill = (elapsed / window_ms) * rate
  tokens = math.min(capacity, tokens + refill)
  last_updated = now
end
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HMSET', key, 'tokens', tokens, 'last_updated', last_updated)
redis.call('PEXPIRE', key, math.max(window_ms * 2, 60000))
local missing = math.max(0, cost - tokens)
local reset_ms = 0
if missing > 0 and rate > 0 then
  reset_ms = math.ceil((missing / rate) * window_ms)
end
return { allowed, math.floor(tokens), reset_ms }
`;

export const SLIDING_WINDOW_LUA = `
-- KEYS[1]: sorted set key
-- ARGV[1]: limit_count
-- ARGV[2]: window_ms
-- ARGV[3]: now_ms
-- ARGV[4]: cost_credits
-- ARGV[5]: unique_req_id
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local req_id = ARGV[5]
local window_start = now - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
local current = redis.call('ZCARD', key)
local allowed = 0
if (current + cost) <= limit then
  for i = 1, cost do
    redis.call('ZADD', key, now, req_id .. ':' .. i)
  end
  current = current + cost
  allowed = 1
end
redis.call('PEXPIRE', key, window_ms + 5000)
local remaining = math.max(0, limit - current)
return { allowed, remaining, window_ms }
`;

export const FIXED_WINDOW_LUA = `
-- KEYS[1]: counter key (bucketed by window index)
-- ARGV[1]: limit_count
-- ARGV[2]: window_ms
-- ARGV[3]: cost_credits
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', key) or '0')
local allowed = 0
if (current + cost) <= limit then
  current = redis.call('INCRBY', key, cost)
  if current == cost then
    redis.call('PEXPIRE', key, window_ms)
  end
  allowed = 1
end
local ttl = redis.call('PTTL', key)
if ttl < 0 then ttl = window_ms end
return { allowed, math.max(0, limit - current), ttl }
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LimiterBackend = 'redis' | 'memory-l1';

export interface EvaluateRateLimitParams {
  keyId: string;
  routePattern: string;
  clientIp: string;
  algorithm: RateLimitAlgo;
  limitCount: number;
  windowSec: number;
  burstCapacity: number;
  /** Units consumed from the limit by this request. */
  costCredits: number;
  reqId: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  backend: LimiterBackend;
}

// ---------------------------------------------------------------------------
// In-memory L1 fallback (algorithms live in @aegisgate/shared and mirror the Lua exactly)
// ---------------------------------------------------------------------------

const memoryStore = createMemoryStore();
setInterval(() => sweepMemoryStore(memoryStore, Date.now()), 30_000).unref();

// ---------------------------------------------------------------------------
// Redis backend
// ---------------------------------------------------------------------------

interface LuaScript {
  source: string;
  sha: string;
}

const script = (source: string): LuaScript => ({ source, sha: createHash('sha1').update(source).digest('hex') });
const SCRIPTS = {
  token_bucket: script(TOKEN_BUCKET_LUA),
  sliding_window: script(SLIDING_WINDOW_LUA),
  fixed_window: script(FIXED_WINDOW_LUA),
} satisfies Record<RateLimitAlgo, LuaScript>;

let redis: Redis | null = null;
let offlineWarned = false;

function warnOffline(detail: string): void {
  if (offlineWarned) return;
  offlineWarned = true;
  console.warn(`[limiter] Redis unavailable (${detail}); falling back to in-memory L1 limiter`);
}

/** Connects to REDIS_URL if configured. Never throws; returns the active backend. */
export async function connectRateLimiter(): Promise<LimiterBackend> {
  const url = process.env.REDIS_URL;
  if (!url) {
    warnOffline('REDIS_URL not set');
    return 'memory-l1';
  }
  if (redis) return getLimiterBackend();

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  client.on('ready', () => {
    offlineWarned = false;
    console.info('[limiter] Redis connected; using Redis Lua backend');
  });
  client.on('error', (err: Error & { code?: string }) => warnOffline(err.message || err.code || 'connection error'));
  redis = client;

  try {
    await client.connect();
  } catch (err) {
    warnOffline(err instanceof Error ? err.message : String(err));
  }
  return getLimiterBackend();
}

export function getLimiterBackend(): LimiterBackend {
  return redis?.status === 'ready' ? 'redis' : 'memory-l1';
}

export async function closeRateLimiter(): Promise<void> {
  const client = redis;
  redis = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

async function runScript(client: Redis, lua: LuaScript, key: string, args: (string | number)[]): Promise<unknown> {
  try {
    return await client.evalsha(lua.sha, 1, key, ...args);
  } catch (err) {
    if (err instanceof Error && err.message.includes('NOSCRIPT')) {
      return client.eval(lua.source, 1, key, ...args);
    }
    throw err;
  }
}

async function runRedisAlgorithm(
  client: Redis,
  algorithm: RateLimitAlgo,
  key: string,
  cfg: AlgorithmConfig,
  now: number,
): Promise<LimiterOutcome> {
  let reply: unknown;
  switch (algorithm) {
    case 'token_bucket':
      reply = await runScript(client, SCRIPTS.token_bucket, key, [cfg.limitCount, cfg.windowMs, cfg.burstCapacity, now, cfg.cost]);
      break;
    case 'sliding_window':
      reply = await runScript(client, SCRIPTS.sliding_window, key, [cfg.limitCount, cfg.windowMs, now, cfg.cost, cfg.reqId]);
      break;
    case 'fixed_window':
      reply = await runScript(client, SCRIPTS.fixed_window, key, [cfg.limitCount, cfg.windowMs, cfg.cost]);
      break;
  }
  if (!Array.isArray(reply) || reply.length < 3) {
    throw new Error('Unexpected Lua reply shape');
  }
  return { allowed: Number(reply[0]) === 1, remaining: Number(reply[1]), resetMs: Number(reply[2]) };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function evaluateRateLimit(params: EvaluateRateLimitParams): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = Math.max(1, Math.round(params.windowSec * 1000));
  const cfg: AlgorithmConfig = {
    limitCount: params.limitCount,
    windowMs,
    burstCapacity: params.burstCapacity,
    cost: Math.max(0, Math.floor(params.costCredits)),
    reqId: params.reqId,
  };
  const key = buildLimiterKey(params, now, windowMs);

  const client = redis;
  if (client && client.status === 'ready') {
    try {
      return { ...(await runRedisAlgorithm(client, params.algorithm, key, cfg, now)), backend: 'redis' };
    } catch (err) {
      warnOffline(err instanceof Error ? err.message : String(err));
    }
  }

  return { ...runMemoryAlgorithm(memoryStore, params.algorithm, key, cfg, now), backend: 'memory-l1' };
}
