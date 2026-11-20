import { z } from 'zod';

// ---------------------------------------------------------------------------
// HTTP header contract
// ---------------------------------------------------------------------------

export const AEGIS_HEADERS = {
  API_KEY: 'x-aegis-key',
  REQUEST_ID: 'x-aegis-request-id',
  ALGO: 'x-aegis-ratelimit-algo',
  LIMIT: 'x-aegis-ratelimit-limit',
  REMAINING: 'x-aegis-ratelimit-remaining',
  RESET: 'x-aegis-ratelimit-reset',
  LATENCY: 'x-aegis-gateway-latency-ms',
  COST_CREDITS: 'x-aegis-billing-cost-credits',
} as const;

export type AegisHeaderName = (typeof AEGIS_HEADERS)[keyof typeof AEGIS_HEADERS];

// ---------------------------------------------------------------------------
// Domain enums
// ---------------------------------------------------------------------------

export const RateLimitAlgoSchema = z.enum(['token_bucket', 'sliding_window', 'fixed_window']);
export type RateLimitAlgo = z.infer<typeof RateLimitAlgoSchema>;

export const LedgerDirectionSchema = z.enum(['DEBIT', 'CREDIT']);
export type LedgerDirection = z.infer<typeof LedgerDirectionSchema>;

export const AccountTypeSchema = z.enum([
  'ASSET_PREPAID_WALLET',
  'REVENUE_PLATFORM_FEES',
  'EXPENSE_CLOUD_INFRA',
  'EQUITY_SYSTEM_SEED',
]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

export const UsageLogEventSchema = z.object({
  requestId: z.string(),
  projectId: z.string(),
  apiKeyId: z.string().nullable(),
  route: z.string(),
  method: z.string(),
  statusCode: z.number().int(),
  latencyMs: z.number().nonnegative(),
  costCredits: z.number().int().nonnegative(),
  clientIp: z.string(),
  blockedReason: z.string().nullable(),
  timestamp: z.number(),
});
export type UsageLogEvent = z.infer<typeof UsageLogEventSchema>;

export const CheckRateLimitRequestSchema = z.object({
  apiKey: z.string(),
  route: z.string(),
  method: z.string(),
  clientIp: z.string(),
  costOverride: z.number().int().nonnegative().optional(),
});
export type CheckRateLimitRequest = z.infer<typeof CheckRateLimitRequestSchema>;

export const CheckRateLimitResponseSchema = z.object({
  allowed: z.boolean(),
  statusCode: z.number().int(),
  algorithm: z.string(),
  limit: z.number(),
  remaining: z.number(),
  resetMs: z.number(),
  costCredits: z.number(),
  remainingBudgetCredits: z.number(),
  gatewayLatencyMs: z.number(),
  requestId: z.string(),
  reason: z.string().optional(),
});
export type CheckRateLimitResponse = z.infer<typeof CheckRateLimitResponseSchema>;

// ---------------------------------------------------------------------------
// Ledger hash chain
// ---------------------------------------------------------------------------

export const LEDGER_GENESIS_HASH = `GENESIS_${'0'.repeat(56)}`;

/** Canonical pre-image of a ledger entry hash (SHA-256 hex of this string). */
export function ledgerHashPayload(
  prevHash: string,
  txId: string,
  accountId: string,
  direction: string,
  amountCredits: number,
  timestampIso: string,
): string {
  return `${prevHash}|${txId}|${accountId}|${direction}|${amountCredits}|${timestampIso}`;
}
