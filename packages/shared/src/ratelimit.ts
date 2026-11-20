import type { RateLimitAlgo } from './contracts';

// In-memory rate-limit algorithms. These mirror the gateway's Redis Lua scripts exactly and are
// used for the gateway's L1 fallback, the burst simulator, and the CLI's offline `sim` command.

export interface LimiterOutcome {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export interface AlgorithmConfig {
  limitCount: number;
  windowMs: number;
  burstCapacity: number;
  cost: number;
  reqId: string;
}

export interface LimiterIdentity {
  algorithm: RateLimitAlgo;
  keyId: string;
  routePattern: string;
  clientIp: string;
}

export interface MemoryStore {
  buckets: Map<string, { tokens: number; lastUpdated: number; expiresAt: number }>;
  windows: Map<string, { stamps: number[]; expiresAt: number }>;
  counters: Map<string, { count: number; expiresAt: number }>;
}

/** Fixed-window keys are bucketed by window index so each window gets its own counter. */
export function buildLimiterKey(identity: LimiterIdentity, now: number, windowMs: number): string {
  const base = `aegis:rl:${identity.algorithm}:${identity.keyId}:${identity.routePattern}:${identity.clientIp}`;
  return identity.algorithm === 'fixed_window' ? `${base}:${Math.floor(now / windowMs)}` : base;
}

export function createMemoryStore(): MemoryStore {
  return { buckets: new Map(), windows: new Map(), counters: new Map() };
}

function tokenBucket(store: MemoryStore, key: string, cfg: AlgorithmConfig, now: number): LimiterOutcome {
  const rate = cfg.limitCount;
  const capacity = cfg.burstCapacity;
  const existing = store.buckets.get(key);
  const live = existing && existing.expiresAt > now ? existing : undefined;

  let tokens = capacity;
  if (live) {
    const elapsed = Math.max(0, now - live.lastUpdated);
    tokens = Math.min(capacity, live.tokens + (elapsed / cfg.windowMs) * rate);
  }

  let allowed = false;
  if (tokens >= cfg.cost) {
    tokens -= cfg.cost;
    allowed = true;
  }

  store.buckets.set(key, { tokens, lastUpdated: now, expiresAt: now + Math.max(cfg.windowMs * 2, 60_000) });

  const missing = Math.max(0, cfg.cost - tokens);
  const resetMs = missing > 0 && rate > 0 ? Math.ceil((missing / rate) * cfg.windowMs) : 0;
  return { allowed, remaining: Math.floor(tokens), resetMs };
}

function slidingWindow(store: MemoryStore, key: string, cfg: AlgorithmConfig, now: number): LimiterOutcome {
  const existing = store.windows.get(key);
  const entry = existing && existing.expiresAt > now ? existing : { stamps: [] as number[], expiresAt: 0 };

  // Equivalent of ZREMRANGEBYSCORE key -inf window_start (inclusive).
  const windowStart = now - cfg.windowMs;
  let expired = 0;
  while (expired < entry.stamps.length && entry.stamps[expired]! <= windowStart) expired++;
  if (expired > 0) entry.stamps.splice(0, expired);

  let allowed = false;
  if (entry.stamps.length + cfg.cost <= cfg.limitCount) {
    for (let i = 0; i < cfg.cost; i++) entry.stamps.push(now);
    allowed = true;
  }

  entry.expiresAt = now + cfg.windowMs + 5_000;
  store.windows.set(key, entry);
  return { allowed, remaining: Math.max(0, cfg.limitCount - entry.stamps.length), resetMs: cfg.windowMs };
}

function fixedWindow(store: MemoryStore, key: string, cfg: AlgorithmConfig, now: number): LimiterOutcome {
  const existing = store.counters.get(key);
  let entry = existing && existing.expiresAt > now ? existing : undefined;
  let current = entry?.count ?? 0;

  let allowed = false;
  if (current + cfg.cost <= cfg.limitCount) {
    if (!entry) {
      entry = { count: 0, expiresAt: now + cfg.windowMs };
      store.counters.set(key, entry);
    }
    entry.count += cfg.cost;
    current = entry.count;
    allowed = true;
  }

  const ttl = entry ? entry.expiresAt - now : cfg.windowMs;
  return { allowed, remaining: Math.max(0, cfg.limitCount - current), resetMs: ttl };
}

export function runMemoryAlgorithm(
  store: MemoryStore,
  algorithm: RateLimitAlgo,
  key: string,
  cfg: AlgorithmConfig,
  now: number,
): LimiterOutcome {
  switch (algorithm) {
    case 'token_bucket':
      return tokenBucket(store, key, cfg, now);
    case 'sliding_window':
      return slidingWindow(store, key, cfg, now);
    case 'fixed_window':
      return fixedWindow(store, key, cfg, now);
  }
}

export interface RouteRuleLike {
  routePattern: string;
  httpMethod: string;
  priority: number;
}

/**
 * Picks the rule for a route: exact match first, then prefix wildcards (`/api/room/*`; highest
 * priority, then longest prefix), then `*`. Respects `httpMethod === 'ALL' || httpMethod === method`.
 * Returns undefined when nothing matches (callers apply their own default).
 */
export function findMatchingRule<T extends RouteRuleLike>(route: string, method: string, rules: readonly T[]): T | undefined {
  const m = method.toUpperCase();
  let exact: T | undefined;
  let prefixed: T | undefined;
  let prefixLen = -1;
  let wildcard: T | undefined;

  for (const rule of rules) {
    const hm = rule.httpMethod.toUpperCase();
    if (hm !== 'ALL' && hm !== m) continue;
    const pattern = rule.routePattern;

    if (pattern === route) {
      if (!exact || rule.priority > exact.priority) exact = rule;
    } else if (pattern === '*') {
      if (!wildcard || rule.priority > wildcard.priority) wildcard = rule;
    } else if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      if (!route.startsWith(prefix) && route !== bare) continue;
      if (!prefixed || rule.priority > prefixed.priority || (rule.priority === prefixed.priority && prefix.length > prefixLen)) {
        prefixed = rule;
        prefixLen = prefix.length;
      }
    }
  }
  return exact ?? prefixed ?? wildcard;
}

export function sweepMemoryStore(store: MemoryStore, now: number): void {
  for (const map of [store.buckets, store.windows, store.counters] as Map<string, { expiresAt: number }>[]) {
    for (const [key, entry] of map) {
      if (entry.expiresAt <= now) map.delete(key);
    }
  }
}
