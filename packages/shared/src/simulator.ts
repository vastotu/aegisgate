import { z } from 'zod';
import { RateLimitAlgoSchema } from './contracts';
import { buildLimiterKey, createMemoryStore, runMemoryAlgorithm } from './ratelimit';

export const SimulateBurstRequestSchema = z.object({
  algorithm: RateLimitAlgoSchema,
  limitCount: z.number().int().min(1).max(100_000),
  windowSec: z.number().int().min(1).max(86_400),
  burstCapacity: z.number().int().min(1).max(100_000).optional(),
  totalRequests: z.number().int().min(1).max(20_000),
  scenario: z.enum(['boundary_burst', 'steady_flood']).default('boundary_burst'),
});
export type SimulateBurstRequest = z.infer<typeof SimulateBurstRequestSchema>;

export interface SimulationTick {
  tickMs: number;
  requested: number;
  allowed: number;
  blocked: number;
  tokensRemaining: number;
}

export interface SimulationResult {
  config: Required<SimulateBurstRequest>;
  summary: { total: number; allowed: number; blocked: number; peakBurstRate: number };
  timeline: SimulationTick[];
}

const TICK_COUNT = 20;
/** Requests land in [W - 100ms, W + 100ms), e.g. t = 59.9s -> 60.1s for a 60s window. */
export const BOUNDARY_SPREAD_MS = 100;

function buildSchedule(
  scenario: SimulateBurstRequest['scenario'],
  total: number,
  windowMs: number,
): { timestamps: number[]; spanStart: number; spanEnd: number } {
  if (scenario === 'boundary_burst') {
    const before = Math.ceil(total / 2);
    const after = total - before;
    const timestamps: number[] = [];
    for (let i = 0; i < before; i++) timestamps.push(windowMs - BOUNDARY_SPREAD_MS + Math.floor((i * BOUNDARY_SPREAD_MS) / before));
    for (let i = 0; i < after; i++) timestamps.push(windowMs + Math.floor((i * BOUNDARY_SPREAD_MS) / after));
    return { timestamps, spanStart: windowMs - BOUNDARY_SPREAD_MS, spanEnd: windowMs + BOUNDARY_SPREAD_MS };
  }

  // steady_flood: evenly spaced over two full windows.
  const span = windowMs * 2;
  const timestamps = Array.from({ length: total }, (_, i) => Math.floor((i * span) / total));
  return { timestamps, spanStart: 0, spanEnd: span };
}

/** Max allowed requests inside any rolling window of `windowMs` (2x limit reveals the fixed-window boundary spike). */
function peakInRollingWindow(sortedStamps: number[], windowMs: number): number {
  let peak = 0;
  let lo = 0;
  for (let hi = 0; hi < sortedStamps.length; hi++) {
    while (sortedStamps[hi]! - sortedStamps[lo]! >= windowMs) lo++;
    peak = Math.max(peak, hi - lo + 1);
  }
  return peak;
}

/** Deterministic, zero-network simulation using the same in-memory algorithms as the gateway's L1 fallback. */
export function simulateBurst(input: SimulateBurstRequest): SimulationResult {
  const windowMs = input.windowSec * 1000;
  const burstCapacity = input.burstCapacity ?? input.limitCount;
  const { timestamps, spanStart, spanEnd } = buildSchedule(input.scenario, input.totalRequests, windowMs);
  const tickSize = Math.max(1, Math.ceil((spanEnd - spanStart) / TICK_COUNT));

  const timeline: SimulationTick[] = Array.from({ length: TICK_COUNT }, (_, i) => ({
    tickMs: spanStart + i * tickSize,
    requested: 0,
    allowed: 0,
    blocked: 0,
    tokensRemaining: -1,
  }));

  const store = createMemoryStore();
  const identity = { algorithm: input.algorithm, keyId: 'simulation', routePattern: '*', clientIp: '0.0.0.0' };
  const allowedAt: number[] = [];

  timestamps.forEach((t, i) => {
    const outcome = runMemoryAlgorithm(
      store,
      input.algorithm,
      buildLimiterKey(identity, t, windowMs),
      { limitCount: input.limitCount, windowMs, burstCapacity, cost: 1, reqId: `sim-${i}` },
      t,
    );
    const tick = timeline[Math.min(TICK_COUNT - 1, Math.floor((t - spanStart) / tickSize))]!;
    tick.requested++;
    if (outcome.allowed) {
      tick.allowed++;
      allowedAt.push(t);
    } else {
      tick.blocked++;
    }
    tick.tokensRemaining = outcome.remaining;
  });

  // Carry state forward through idle ticks.
  let carry = input.algorithm === 'token_bucket' ? burstCapacity : input.limitCount;
  for (const tick of timeline) {
    if (tick.tokensRemaining < 0) tick.tokensRemaining = carry;
    carry = tick.tokensRemaining;
  }

  return {
    config: { ...input, burstCapacity },
    summary: {
      total: timestamps.length,
      allowed: allowedAt.length,
      blocked: timestamps.length - allowedAt.length,
      peakBurstRate: peakInRollingWindow(allowedAt, windowMs),
    },
    timeline,
  };
}
