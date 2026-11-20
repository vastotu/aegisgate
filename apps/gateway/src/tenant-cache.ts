import {
  apiKeys,
  db,
  ledgerAccounts,
  projects,
  rateLimitRules,
  type ApiKey,
  type Project,
  type RateLimitRule,
} from '@aegisgate/db';
import { findMatchingRule, hashApiKey } from '@aegisgate/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getUnsettledCredits } from './batch-worker';
import { isDatabaseUnavailable } from './db-errors';
import { getOfflineTenant } from './showcase-fallback';

const TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 5_000;
const STALE_GRACE_MS = 5_000;
const MAX_ENTRIES = 10_000;
const PLATFORM_REVENUE_CODE = 'PLATFORM:REVENUE';

export interface ResolvedTenantContext {
  project: Project;
  apiKey: ApiKey;
  /** Sorted by priority DESC. */
  rules: RateLimitRule[];
  walletAccountId: string;
  platformRevenueAccountId: string;
  /** DB balance minus unsettled edge charges; decremented optimistically on allowed requests. */
  liveWalletBalanceCredits: number;
}

/** Thrown when the tenant cannot be resolved because the database is unavailable or misconfigured. */
export class TenantResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TenantResolutionError';
  }
}

interface CacheEntry {
  value: ResolvedTenantContext | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ResolvedTenantContext | null>>();
let generation = 0;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
}, TTL_MS).unref();

async function loadTenant(keyHash: string): Promise<ResolvedTenantContext | null> {
  const [row] = await db
    .select({ apiKey: apiKeys, project: projects })
    .from(apiKeys)
    .innerJoin(projects, eq(apiKeys.projectId, projects.id))
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1);
  if (!row) return null;

  const walletCode = `WALLET:${row.project.slug}`;
  const [rules, accounts] = await Promise.all([
    db
      .select()
      .from(rateLimitRules)
      .where(eq(rateLimitRules.projectId, row.project.id))
      .orderBy(desc(rateLimitRules.priority), asc(rateLimitRules.createdAt)),
    db
      .select({ id: ledgerAccounts.id, accountCode: ledgerAccounts.accountCode, balanceCredits: ledgerAccounts.balanceCredits })
      .from(ledgerAccounts)
      .where(inArray(ledgerAccounts.accountCode, [walletCode, PLATFORM_REVENUE_CODE])),
  ]);

  const wallet = accounts.find((a) => a.accountCode === walletCode);
  const revenue = accounts.find((a) => a.accountCode === PLATFORM_REVENUE_CODE);
  if (!wallet || !revenue) {
    throw new TenantResolutionError(`Ledger accounts missing for project '${row.project.slug}'`);
  }

  return {
    project: row.project,
    apiKey: row.apiKey,
    rules,
    walletAccountId: wallet.id,
    platformRevenueAccountId: revenue.id,
    liveWalletBalanceCredits: wallet.balanceCredits - getUnsettledCredits(row.project.id),
  };
}

async function refresh(keyHash: string, stale: CacheEntry | undefined): Promise<ResolvedTenantContext | null> {
  const startedGeneration = generation;
  try {
    const value = await loadTenant(keyHash);
    if (startedGeneration === generation && (value || cache.size < MAX_ENTRIES)) {
      cache.set(keyHash, { value, expiresAt: Date.now() + (value ? TTL_MS : NEGATIVE_TTL_MS) });
    }
    return value;
  } catch (err) {
    // Serve stale config while the database is unreachable.
    if (stale?.value && startedGeneration === generation) {
      stale.expiresAt = Date.now() + STALE_GRACE_MS;
      cache.set(keyHash, stale);
      return stale.value;
    }
    // Postgres down: resolve the built-in showcase tenants from the in-memory replica.
    if (isDatabaseUnavailable(err)) {
      const offline = getOfflineTenant(keyHash);
      if (offline) {
        const { walletBalanceCredits, ...rest } = offline;
        const ctx: ResolvedTenantContext = {
          ...rest,
          liveWalletBalanceCredits: walletBalanceCredits - getUnsettledCredits(offline.project.id),
        };
        if (startedGeneration === generation) cache.set(keyHash, { value: ctx, expiresAt: Date.now() + STALE_GRACE_MS });
        return ctx;
      }
    }
    if (err instanceof TenantResolutionError) throw err;
    throw new TenantResolutionError('Tenant store unavailable', { cause: err });
  }
}

export function resolveTenant(keyHash: string): Promise<ResolvedTenantContext | null> {
  const hit = cache.get(keyHash);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);

  let pending = inflight.get(keyHash);
  if (!pending) {
    pending = refresh(keyHash, hit).finally(() => inflight.delete(keyHash));
    inflight.set(keyHash, pending);
  }
  return pending;
}

export function resolveTenantByRawKey(rawKey: string): Promise<ResolvedTenantContext | null> {
  return resolveTenant(hashApiKey(rawKey));
}

/** Clears the L1 cache so control-plane mutations take effect immediately. */
export function invalidateTenantCache(): void {
  generation++;
  cache.clear();
}

const DEFAULT_RULE: Readonly<RateLimitRule> = Object.freeze({
  id: 'default',
  projectId: '',
  routePattern: '*',
  httpMethod: 'ALL',
  algorithm: 'token_bucket',
  limitCount: 100,
  windowSec: 60,
  burstCapacity: 120,
  costWeightCredits: 1,
  priority: -1,
  createdAt: new Date(0),
});

/**
 * Picks the rule for a route: exact match first, then prefix wildcards (`/api/room/*`, highest
 * priority then longest prefix), then `*`. Falls back to a built-in default rule.
 */
export function matchRouteRule(route: string, method: string, rules: RateLimitRule[]): RateLimitRule {
  return findMatchingRule(route, method, rules) ?? DEFAULT_RULE;
}
