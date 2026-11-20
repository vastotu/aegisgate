import { AEGIS_HEADERS, type CheckRateLimitResponse } from '@aegisgate/shared';

// Isomorphic randomness from @aegisgate/shared (same implementation the gateway uses).
export { randomHex, randomUuid as uuid } from '@aegisgate/shared';

/** Deterministic PRNG (mulberry32), same as the gateway's offline store. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeRoute(route: string): string {
  const path = route.split('?')[0]!.split('#')[0] || '/';
  return path.startsWith('/') || path === '*' ? path : `/${path}`;
}

/** Concrete path used for synthetic history of a rule pattern. */
export const sampleRouteFor = (pattern: string): string =>
  pattern === '*' ? '/api/leaderboard' : pattern.endsWith('*') ? `${pattern.slice(0, -1)}index` : pattern;

/** Same header set the gateway returns (the raw key is never echoed, only its prefix). */
export function decisionHeaders(body: CheckRateLimitResponse, keyPrefix?: string): Record<string, string> {
  const headers: Record<string, string> = {
    [AEGIS_HEADERS.REQUEST_ID]: body.requestId,
    [AEGIS_HEADERS.ALGO]: body.algorithm,
    [AEGIS_HEADERS.LIMIT]: String(body.limit),
    [AEGIS_HEADERS.REMAINING]: String(body.remaining),
    [AEGIS_HEADERS.RESET]: String(body.resetMs),
    [AEGIS_HEADERS.LATENCY]: String(body.gatewayLatencyMs),
    [AEGIS_HEADERS.COST_CREDITS]: String(body.costCredits),
  };
  if (keyPrefix) headers[AEGIS_HEADERS.API_KEY] = keyPrefix;
  if (body.statusCode === 429) headers['retry-after'] = String(Math.max(1, Math.ceil(body.resetMs / 1000)));
  return headers;
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const ROUTE_PATTERN = /^(\*|\/[^*]*\*?)$/;

export const DEFAULT_RULE_SPEC = {
  routePattern: '*',
  httpMethod: 'ALL',
  algorithm: 'token_bucket',
  limitCount: 100,
  windowSec: 60,
  burstCapacity: 120,
  costWeightCredits: 1,
  priority: 0,
} as const;
