import {
  buildLimiterKey,
  findMatchingRule,
  RateLimitAlgoSchema,
  runMemoryAlgorithm,
  type CheckRateLimitResponse,
} from '@aegisgate/shared';
import { decisionHeaders, DEFAULT_RULE_SPEC, normalizeRoute, randomHex } from './engine-utils';
import { MAX_BATCH_SIZE, RECENT_EVENTS_CAPACITY, type LocalTenant, type SandboxState } from './local-state';
import type { CheckInput, CheckOutcome } from './types';

type Fields = Omit<CheckRateLimitResponse, 'statusCode' | 'gatewayLatencyMs' | 'requestId'>;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Synchronous port of the gateway hot path: auth → budget → rate limit → write-behind telemetry. */
export function evaluateCheck(state: SandboxState, input: CheckInput): CheckOutcome {
  const startedAt = performance.now();
  const requestId = `req_${randomHex(16)}`;
  const route = normalizeRoute(input.route);
  const method = input.method.toUpperCase();
  const tenant = state.byKey.get(input.apiKey);

  const decide = (httpStatus: number, fields: Fields, blockedReason?: string | null): CheckOutcome => {
    const gatewayLatencyMs = round3(performance.now() - startedAt);
    const body: CheckRateLimitResponse = { ...fields, statusCode: httpStatus, gatewayLatencyMs, requestId };
    if (tenant && blockedReason !== undefined) enqueue(state, tenant, body, route, method, input.clientIp, blockedReason);
    return { httpStatus, body, headers: decisionHeaders(body, tenant?.apiKey.keyPrefix), rttMs: gatewayLatencyMs };
  };
  const rejectFields = (reason: string): Fields => ({
    allowed: false,
    algorithm: 'none',
    limit: 0,
    remaining: 0,
    resetMs: 0,
    costCredits: 0,
    remainingBudgetCredits: 0,
    reason,
  });

  if (!input.apiKey) return decide(401, rejectFields('MISSING_API_KEY'));
  if (!tenant) return decide(401, rejectFields('INVALID_API_KEY'));

  const rule = findMatchingRule(route, method, tenant.rules) ?? DEFAULT_RULE_SPEC;
  const algorithm = RateLimitAlgoSchema.safeParse(rule.algorithm).data ?? 'token_bucket';
  const limit = algorithm === 'token_bucket' ? rule.burstCapacity : rule.limitCount;
  const costCredits = input.costOverride ?? rule.costWeightCredits;
  const liveBalance = tenant.wallet.balance - tenant.unsettled;

  if (liveBalance < costCredits) {
    return decide(
      402,
      { allowed: false, algorithm, limit, remaining: 0, resetMs: 0, costCredits: 0, remainingBudgetCredits: liveBalance, reason: 'BUDGET_EXHAUSTED' },
      'BUDGET_EXHAUSTED',
    );
  }

  const now = Date.now();
  const windowMs = Math.max(1, rule.windowSec * 1000);
  const identity = { algorithm, keyId: tenant.apiKey.id, routePattern: rule.routePattern, clientIp: input.clientIp };
  const rl = runMemoryAlgorithm(
    state.limiter,
    algorithm,
    buildLimiterKey(identity, now, windowMs),
    { limitCount: rule.limitCount, windowMs, burstCapacity: rule.burstCapacity, cost: 1, reqId: requestId },
    now,
  );

  if (!rl.allowed) {
    return decide(
      429,
      { allowed: false, algorithm, limit, remaining: rl.remaining, resetMs: rl.resetMs, costCredits: 0, remainingBudgetCredits: liveBalance, reason: 'RATE_LIMIT_EXCEEDED' },
      'RATE_LIMIT_EXCEEDED',
    );
  }

  tenant.unsettled += costCredits;
  return decide(
    200,
    { allowed: true, algorithm, limit, remaining: rl.remaining, resetMs: rl.resetMs, costCredits, remainingBudgetCredits: liveBalance - costCredits },
    null,
  );
}

function enqueue(
  state: SandboxState,
  tenant: LocalTenant,
  body: CheckRateLimitResponse,
  route: string,
  method: string,
  clientIp: string,
  blockedReason: string | null,
): void {
  const event = {
    requestId: body.requestId,
    projectId: tenant.project.id,
    apiKeyId: tenant.apiKey.id,
    route,
    method,
    statusCode: body.statusCode,
    latencyMs: body.gatewayLatencyMs,
    costCredits: body.costCredits,
    clientIp,
    blockedReason,
    timestamp: Date.now(),
  };
  state.pending.push(event);
  state.recent.unshift(event);
  if (state.recent.length > RECENT_EVENTS_CAPACITY) state.recent.length = RECENT_EVENTS_CAPACITY;
  if (state.pending.length > MAX_BATCH_SIZE * 20) state.pending.splice(0, state.pending.length - MAX_BATCH_SIZE * 20);
}
