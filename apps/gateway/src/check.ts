import { randomUUID } from 'node:crypto';
import { AEGIS_HEADERS, RateLimitAlgoSchema, type CheckRateLimitResponse } from '@aegisgate/shared';
import type { FastifyReply } from 'fastify';
import { enqueueUsageLog } from './batch-worker';
import { evaluateRateLimit } from './limiter';
import { matchRouteRule, resolveTenantByRawKey, type ResolvedTenantContext } from './tenant-cache';

export interface GatewayCheckInput {
  rawKey: string | undefined;
  route: string;
  method: string;
  clientIp: string;
  costOverride?: number;
  /** When set (proxy mode), the key must belong to this project slug. */
  expectedSlug?: string;
}

export interface GatewayDecision {
  httpStatus: number;
  body: CheckRateLimitResponse;
  headers: Record<string, string>;
  tenant: ResolvedTenantContext | null;
  route: string;
}

type DecisionFields = Omit<CheckRateLimitResponse, 'statusCode' | 'gatewayLatencyMs' | 'requestId'>;

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export function normalizeRoute(route: string): string {
  const path = route.split('?')[0]!.split('#')[0] || '/';
  return path.startsWith('/') || path === '*' ? path : `/${path}`;
}

function buildHeaders(body: CheckRateLimitResponse, keyPrefix: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    [AEGIS_HEADERS.REQUEST_ID]: body.requestId,
    [AEGIS_HEADERS.ALGO]: body.algorithm,
    [AEGIS_HEADERS.LIMIT]: String(body.limit),
    [AEGIS_HEADERS.REMAINING]: String(body.remaining),
    [AEGIS_HEADERS.RESET]: String(body.resetMs),
    [AEGIS_HEADERS.LATENCY]: String(body.gatewayLatencyMs),
    [AEGIS_HEADERS.COST_CREDITS]: String(body.costCredits),
  };
  // Echo only the masked key prefix, never the raw key.
  if (keyPrefix) headers[AEGIS_HEADERS.API_KEY] = keyPrefix;
  return headers;
}

export function applyDecisionHeaders(reply: FastifyReply, decision: GatewayDecision): void {
  reply.headers(decision.headers);
  if (decision.httpStatus === 429) {
    reply.header('retry-after', String(Math.max(1, Math.ceil(decision.body.resetMs / 1000))));
  }
}

/** Shared hot path for `/v1/check` and the reverse proxy: auth, budget, rate limit, telemetry. */
export async function runGatewayCheck(input: GatewayCheckInput): Promise<GatewayDecision> {
  const startedAt = performance.now();
  const requestId = `req_${randomUUID().replace(/-/g, '')}`;
  const route = normalizeRoute(input.route);
  const method = input.method.toUpperCase();

  const decide = (
    httpStatus: number,
    tenant: ResolvedTenantContext | null,
    fields: DecisionFields,
    log?: { blockedReason: string | null },
  ): GatewayDecision => {
    const gatewayLatencyMs = round(performance.now() - startedAt, 3);
    const body: CheckRateLimitResponse = { ...fields, statusCode: httpStatus, gatewayLatencyMs, requestId };
    if (tenant && log) {
      enqueueUsageLog({
        requestId,
        projectId: tenant.project.id,
        apiKeyId: tenant.apiKey.id,
        route,
        method,
        statusCode: httpStatus,
        latencyMs: gatewayLatencyMs,
        costCredits: body.costCredits,
        clientIp: input.clientIp,
        blockedReason: log.blockedReason,
        timestamp: Date.now(),
      });
    }
    return { httpStatus, body, headers: buildHeaders(body, tenant?.apiKey.keyPrefix), tenant, route };
  };

  const reject = (httpStatus: number, reason: string, tenant: ResolvedTenantContext | null = null) =>
    decide(httpStatus, tenant, {
      allowed: false,
      algorithm: 'none',
      limit: 0,
      remaining: 0,
      resetMs: 0,
      costCredits: 0,
      remainingBudgetCredits: tenant?.liveWalletBalanceCredits ?? 0,
      reason,
    });

  if (!input.rawKey) return reject(401, 'MISSING_API_KEY');

  let tenant: ResolvedTenantContext | null;
  try {
    tenant = await resolveTenantByRawKey(input.rawKey);
  } catch {
    return reject(503, 'TENANT_STORE_UNAVAILABLE');
  }
  if (!tenant) return reject(401, 'INVALID_API_KEY');
  if (input.expectedSlug && tenant.project.slug !== input.expectedSlug) {
    return reject(403, 'KEY_PROJECT_MISMATCH', tenant);
  }

  const rule = matchRouteRule(route, method, tenant.rules);
  const algorithm = RateLimitAlgoSchema.safeParse(rule.algorithm).data ?? 'token_bucket';
  const limit = algorithm === 'token_bucket' ? rule.burstCapacity : rule.limitCount;
  const costCredits = input.costOverride ?? rule.costWeightCredits;

  if (tenant.liveWalletBalanceCredits < costCredits) {
    return decide(
      402,
      tenant,
      {
        allowed: false,
        algorithm,
        limit,
        remaining: 0,
        resetMs: 0,
        costCredits: 0,
        remainingBudgetCredits: tenant.liveWalletBalanceCredits,
        reason: 'BUDGET_EXHAUSTED',
      },
      { blockedReason: 'BUDGET_EXHAUSTED' },
    );
  }

  // Each request consumes one unit of the rate limit; costCredits is the billing weight.
  const rl = await evaluateRateLimit({
    keyId: tenant.apiKey.id,
    routePattern: rule.routePattern,
    clientIp: input.clientIp,
    algorithm,
    limitCount: rule.limitCount,
    windowSec: rule.windowSec,
    burstCapacity: rule.burstCapacity,
    costCredits: 1,
    reqId: requestId,
  });

  if (!rl.allowed) {
    return decide(
      429,
      tenant,
      {
        allowed: false,
        algorithm,
        limit,
        remaining: rl.remaining,
        resetMs: rl.resetMs,
        costCredits: 0,
        remainingBudgetCredits: tenant.liveWalletBalanceCredits,
        reason: 'RATE_LIMIT_EXCEEDED',
      },
      { blockedReason: 'RATE_LIMIT_EXCEEDED' },
    );
  }

  tenant.liveWalletBalanceCredits -= costCredits;
  return decide(
    200,
    tenant,
    {
      allowed: true,
      algorithm,
      limit,
      remaining: rl.remaining,
      resetMs: rl.resetMs,
      costCredits,
      remainingBudgetCredits: tenant.liveWalletBalanceCredits,
    },
    { blockedReason: null },
  );
}
