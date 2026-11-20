import assert from 'node:assert/strict';
import { createMemoryStore, findMatchingRule, runMemoryAlgorithm, simulateBurst, type AlgorithmConfig } from '@aegisgate/shared';
import type { Check } from './types';

const T0 = 1_700_000_000_000;

export const checks: Check[] = [
  {
    name: 'Token bucket allows a burst up to capacity, then blocks; refills at limit/window',
    run: () => {
      const store = createMemoryStore();
      const cfg: AlgorithmConfig = { limitCount: 10, windowMs: 60_000, burstCapacity: 15, cost: 1, reqId: 'tb' };
      const burst = Array.from({ length: 20 }, () => runMemoryAlgorithm(store, 'token_bucket', 'k', cfg, T0));
      assert.equal(burst.filter((r) => r.allowed).length, 15);
      assert.ok(burst.slice(15).every((r) => !r.allowed && r.remaining === 0 && r.resetMs > 0));
      // 10 tokens / 60s = 1 token every 6s.
      assert.equal(runMemoryAlgorithm(store, 'token_bucket', 'k', cfg, T0 + 6_000).allowed, true);
      assert.equal(runMemoryAlgorithm(store, 'token_bucket', 'k', cfg, T0 + 6_000).allowed, false);
    },
  },
  {
    name: 'Sliding window strictly caps at limitCount (120 pkt/s against a 60/s cap), then recovers',
    run: () => {
      const store = createMemoryStore();
      const cfg = (i: number): AlgorithmConfig => ({ limitCount: 60, windowMs: 1_000, burstCapacity: 60, cost: 1, reqId: `sw-${i}` });
      const results = Array.from({ length: 120 }, (_, i) => runMemoryAlgorithm(store, 'sliding_window', 'k', cfg(i), T0 + Math.floor((i * 1000) / 120)));
      assert.equal(results.filter((r) => r.allowed).length, 60);
      assert.equal(runMemoryAlgorithm(store, 'sliding_window', 'k', cfg(999), T0 + 2_000).allowed, true);
    },
  },
  {
    name: 'Route matcher precedence: exact > prefix wildcard > *, honoring httpMethod',
    run: () => {
      const rule = (routePattern: string, priority: number, httpMethod = 'ALL') => ({ routePattern, priority, httpMethod });
      const rules = [rule('*', 0), rule('/api/room/*', 5), rule('/api/room/join', 1), rule('/api/admin', 9, 'POST')];
      assert.equal(findMatchingRule('/api/room/join', 'POST', rules)?.routePattern, '/api/room/join');
      assert.equal(findMatchingRule('/api/room/leave', 'GET', rules)?.routePattern, '/api/room/*');
      assert.equal(findMatchingRule('/api/admin', 'GET', rules)?.routePattern, '*');
      assert.equal(findMatchingRule('/x', 'GET', []), undefined);
    },
  },
  {
    name: 'Boundary burst (200 req, limit 100, burst 120): fixed_window leaks >150, sliding ≤100, token bucket ≤120',
    run: () => {
      const base = { limitCount: 100, windowSec: 60, burstCapacity: 120, totalRequests: 200, scenario: 'boundary_burst' as const };
      const fixed = simulateBurst({ ...base, algorithm: 'fixed_window' }).summary;
      const sliding = simulateBurst({ ...base, algorithm: 'sliding_window' }).summary;
      const bucket = simulateBurst({ ...base, algorithm: 'token_bucket' }).summary;
      assert.ok(fixed.allowed > 150 && fixed.peakBurstRate > 150, `fixed_window allowed ${fixed.allowed}`);
      assert.ok(sliding.allowed <= 100 && sliding.peakBurstRate <= 100, `sliding_window allowed ${sliding.allowed}`);
      assert.ok(bucket.allowed <= 120 && bucket.peakBurstRate <= 120, `token_bucket allowed ${bucket.allowed}`);
      assert.deepEqual([fixed.allowed, sliding.allowed, bucket.allowed], [200, 100, 120]);
    },
  },
];
