import { randomUUID } from 'node:crypto';
import { GENESIS_HASH, type ApiKey, type LedgerEntry, type Project, type RateLimitRule } from '@aegisgate/db';
import { computeLedgerHash, generateApiKey, hashApiKey, SHOWCASE_TENANTS, type UsageLogEvent } from '@aegisgate/shared';

// In-memory replica of the 3 seeded showcase tenants. Used when Postgres is unreachable so
// /v1/check, /proxy and /v1/admin/overview keep working standalone, with a live in-memory
// double-entry ledger (DEBIT WALLET:<slug>, CREDIT PLATFORM:REVENUE) and usage aggregates.

type RuleSpec = Pick<
  RateLimitRule,
  'routePattern' | 'algorithm' | 'limitCount' | 'windowSec' | 'burstCapacity' | 'costWeightCredits' | 'priority'
>;

const SHOWCASE_SPECS = SHOWCASE_TENANTS;

interface OfflineAccount {
  id: string;
  projectId: string | null;
  accountCode: string;
  accountType: string;
  balanceCredits: number;
}

export interface RouteStat {
  route: string;
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  creditsConsumed: number;
}

interface OfflineUsage {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  creditsConsumed: number;
  latencies: number[];
  routes: Map<string, RouteStat>;
}

const emptyUsage = (): OfflineUsage => ({
  totalRequests: 0,
  allowedRequests: 0,
  blockedRequests: 0,
  creditsConsumed: 0,
  latencies: [],
  routes: new Map(),
});

interface OfflineTenant {
  project: Project;
  apiKey: ApiKey;
  rules: RateLimitRule[];
  wallet: OfflineAccount;
  ledger: LedgerEntry[];
  usage: OfflineUsage;
}

export interface UsageSummary {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  creditsConsumed: number;
  p95LatencyMs: number;
}

export interface OfflineTenantView {
  project: Project;
  apiKey: ApiKey;
  rules: RateLimitRule[];
  walletAccountId: string;
  platformRevenueAccountId: string;
  walletBalanceCredits: number;
}

export interface OfflineSnapshot {
  tenants: (OfflineTenantView & { recentLedgerEntries: LedgerEntry[]; usage: UsageSummary; routeStats: RouteStat[] })[];
  revenueBalanceCredits: number;
  platformUsage: UsageSummary;
}

const MAX_LEDGER_ENTRIES = 500;
const MAX_LATENCY_SAMPLES = 2_000;
const HISTORY_ROWS_PER_TENANT = 150;

const offlineId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const revenueAccount: OfflineAccount = {
  id: offlineId(0xf01),
  projectId: null,
  accountCode: 'PLATFORM:REVENUE',
  accountType: 'REVENUE_PLATFORM_FEES',
  balanceCredits: 0,
};
const equityAccount: OfflineAccount = {
  id: offlineId(0xf02),
  projectId: null,
  accountCode: 'SYSTEM:EQUITY_SEED',
  accountType: 'EQUITY_SYSTEM_SEED',
  balanceCredits: 0,
};

const tenantsByKeyHash = new Map<string, OfflineTenant>();
const tenantsByProjectId = new Map<string, OfflineTenant>();
/** Deleted offline projects stay routed to the offline store so their buffered events are dropped, not sent to Postgres. */
const deletedProjectIds = new Set<string>();

/** Same convention as Phase 1: DEBIT subtracts from balance, CREDIT adds; per-project hash chain. */
function postTransaction(
  tenant: OfflineTenant,
  debit: OfflineAccount,
  credit: OfflineAccount,
  amountCredits: number,
  description: string,
): string {
  const last = tenant.ledger[tenant.ledger.length - 1];
  const prevHash = last?.entryHash ?? GENESIS_HASH;
  const debitTs = new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1));
  const creditTs = new Date(debitTs.getTime() + 1);
  const transactionId = randomUUID();

  debit.balanceCredits -= amountCredits;
  credit.balanceCredits += amountCredits;

  const debitHash = computeLedgerHash(prevHash, transactionId, debit.id, 'DEBIT', amountCredits, debitTs.toISOString());
  const creditHash = computeLedgerHash(debitHash, transactionId, credit.id, 'CREDIT', amountCredits, creditTs.toISOString());
  const projectId = tenant.project.id;

  tenant.ledger.push(
    { id: randomUUID(), transactionId, projectId, accountId: debit.id, direction: 'DEBIT', amountCredits, balanceAfter: debit.balanceCredits, description, prevHash, entryHash: debitHash, createdAt: debitTs },
    { id: randomUUID(), transactionId, projectId, accountId: credit.id, direction: 'CREDIT', amountCredits, balanceAfter: credit.balanceCredits, description, prevHash: debitHash, entryHash: creditHash, createdAt: creditTs },
  );
  if (tenant.ledger.length > MAX_LEDGER_ENTRIES) tenant.ledger.splice(0, tenant.ledger.length - MAX_LEDGER_ENTRIES);
  return transactionId;
}

function recordUsage(usage: OfflineUsage, route: string, statusCode: number, latencyMs: number, costCredits: number): void {
  const routeStat = usage.routes.get(route) ?? { route, totalRequests: 0, allowedRequests: 0, blockedRequests: 0, creditsConsumed: 0 };
  usage.routes.set(route, routeStat);
  usage.totalRequests++;
  routeStat.totalRequests++;
  if (statusCode < 400) {
    usage.allowedRequests++;
    usage.creditsConsumed += costCredits;
    routeStat.allowedRequests++;
    routeStat.creditsConsumed += costCredits;
  } else {
    usage.blockedRequests++;
    routeStat.blockedRequests++;
  }
  usage.latencies.push(latencyMs);
  if (usage.latencies.length > MAX_LATENCY_SAMPLES) usage.latencies.splice(0, usage.latencies.length - MAX_LATENCY_SAMPLES);
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

function summarize(usage: OfflineUsage): UsageSummary {
  const { totalRequests, allowedRequests, blockedRequests, creditsConsumed, latencies } = usage;
  return { totalRequests, allowedRequests, blockedRequests, creditsConsumed, p95LatencyMs: p95(latencies) };
}

const routeStatsOf = (usage: OfflineUsage): RouteStat[] =>
  [...usage.routes.values()].sort((a, b) => b.totalRequests - a.totalRequests).slice(0, 20).map((r) => ({ ...r }));

/** Concrete path used for synthetic history of a rule pattern. */
const sampleRouteFor = (pattern: string): string =>
  pattern === '*' ? '/api/leaderboard' : pattern.endsWith('*') ? `${pattern.slice(0, -1)}index` : pattern;

/** Deterministic PRNG (mulberry32) so synthetic history matches across restarts. */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(): void {
  const createdAt = new Date();
  const rng = createRng(20260101);

  SHOWCASE_SPECS.forEach((spec, i) => {
    const n = i + 1;
    const rawKey = spec.demoApiKey;

    const project: Project = {
      id: offlineId(n),
      name: spec.name,
      slug: spec.slug,
      description: spec.description,
      upstreamUrl: spec.upstreamUrl,
      monthlyBudgetCredits: spec.monthlyBudgetCredits,
      creditUnitPriceUsd: '0.001000',
      infraCostPerReqUsd: '0.000150',
      isShowcaseTenant: true,
      createdAt,
    };
    const apiKey: ApiKey = {
      id: offlineId(0x100 + n),
      projectId: project.id,
      name: 'Showcase Demo Key',
      keyPrefix: `${rawKey.slice(0, 16)}...`,
      keyHash: hashApiKey(rawKey),
      isActive: true,
      createdAt,
    };
    const rules: RateLimitRule[] = spec.rules
      .map((r, j) => ({ ...r, id: offlineId(0x200 + n * 16 + j), projectId: project.id, httpMethod: 'ALL', createdAt }))
      .sort((a, b) => b.priority - a.priority);
    const wallet: OfflineAccount = {
      id: offlineId(0x300 + n),
      projectId: project.id,
      accountCode: `WALLET:${spec.slug}`,
      accountType: 'ASSET_PREPAID_WALLET',
      balanceCredits: 0,
    };

    const tenant: OfflineTenant = {
      project,
      apiKey,
      rules,
      wallet,
      ledger: [],
      usage: emptyUsage(),
    };

    // Fund the wallet: DEBIT SYSTEM:EQUITY_SEED, CREDIT WALLET:<slug> (mirrors the DB seed).
    postTransaction(tenant, equityAccount, wallet, spec.monthlyBudgetCredits, `Initial prepaid credit grant for ${spec.slug}`);

    // Synthetic 24h history (same mix as the DB seed: ~18% 429s, 1.1-4.8ms latency).
    for (let k = 0; k < HISTORY_ROWS_PER_TENANT; k++) {
      const rule = rules[Math.floor(rng() * rules.length)]!;
      const blocked = rng() < 0.18;
      recordUsage(
        tenant.usage,
        sampleRouteFor(rule.routePattern),
        blocked ? 429 : 200,
        Math.round((1.1 + rng() * 3.7) * 100) / 100,
        blocked ? 0 : rule.costWeightCredits,
      );
    }

    tenantsByKeyHash.set(apiKey.keyHash, tenant);
    tenantsByProjectId.set(project.id, tenant);
  });
}

bootstrap();

function toView(t: OfflineTenant): OfflineTenantView {
  return {
    project: t.project,
    apiKey: t.apiKey,
    rules: t.rules,
    walletAccountId: t.wallet.id,
    platformRevenueAccountId: revenueAccount.id,
    walletBalanceCredits: t.wallet.balanceCredits,
  };
}

export function getOfflineTenant(keyHash: string): OfflineTenantView | null {
  const tenant = tenantsByKeyHash.get(keyHash);
  return tenant ? toView(tenant) : null;
}

export function isOfflineProject(projectId: string): boolean {
  return tenantsByProjectId.has(projectId) || deletedProjectIds.has(projectId);
}

/**
 * Records usage aggregates and posts one in-memory settlement per project
 * (DEBIT WALLET:<slug>, CREDIT PLATFORM:REVENUE). Returns settled credits per project.
 */
export function settleOfflineUsage(events: UsageLogEvent[]): Map<string, number> {
  const groups = new Map<string, { credits: number; count: number }>();
  for (const e of events) {
    const tenant = tenantsByProjectId.get(e.projectId);
    if (!tenant) continue;
    recordUsage(tenant.usage, e.route, e.statusCode, e.latencyMs, e.costCredits);
    if (e.statusCode < 400 && e.costCredits > 0) {
      const g = groups.get(e.projectId) ?? { credits: 0, count: 0 };
      g.credits += e.costCredits;
      g.count += 1;
      groups.set(e.projectId, g);
    }
  }

  const settled = new Map<string, number>();
  for (const [projectId, { credits, count }] of groups) {
    const tenant = tenantsByProjectId.get(projectId)!;
    postTransaction(tenant, tenant.wallet, revenueAccount, credits, `Batch API usage settlement (${count} requests)`);
    settled.set(projectId, credits);
  }
  return settled;
}

export function getOfflineSnapshot(): OfflineSnapshot {
  const tenants = [...tenantsByProjectId.values()];
  const all = emptyUsage();
  for (const t of tenants) {
    all.totalRequests += t.usage.totalRequests;
    all.allowedRequests += t.usage.allowedRequests;
    all.blockedRequests += t.usage.blockedRequests;
    all.creditsConsumed += t.usage.creditsConsumed;
    all.latencies.push(...t.usage.latencies);
  }

  return {
    tenants: tenants.map((t) => ({
      ...toView(t),
      recentLedgerEntries: t.ledger.slice(-30).reverse(),
      usage: summarize(t.usage),
      routeStats: routeStatsOf(t.usage),
    })),
    revenueBalanceCredits: revenueAccount.balanceCredits,
    platformUsage: summarize(all),
  };
}

// ---------------------------------------------------------------------------
// Offline mutations (control plane keeps working while Postgres is down)
// ---------------------------------------------------------------------------

export interface ProjectRef {
  projectId?: string;
  projectSlug?: string;
}

const findTenant = (ref: ProjectRef): OfflineTenant | undefined =>
  ref.projectId
    ? tenantsByProjectId.get(ref.projectId)
    : [...tenantsByProjectId.values()].find((t) => t.project.slug === ref.projectSlug);

export class OfflineConflictError extends Error {}

export interface CreateOfflineProjectInput {
  name: string;
  slug: string;
  upstreamUrl: string;
  description?: string;
  monthlyBudgetCredits: number;
}

export interface CreatedOfflineProject {
  project: Project;
  apiKey: string;
  apiKeyId: string;
  keyPrefix: string;
  walletAccountId: string;
  initialCredits: number;
  rateLimitRules: RateLimitRule[];
}

const DEFAULT_RULE_SPECS: RuleSpec[] = [
  { routePattern: '*', algorithm: 'token_bucket', limitCount: 100, windowSec: 60, burstCapacity: 120, costWeightCredits: 1, priority: 0 },
];

/** Creates a tenant in memory, funds its wallet (DEBIT SYSTEM:EQUITY_SEED, CREDIT WALLET:<slug>) and returns the raw key. */
export function createOfflineProject(input: CreateOfflineProjectInput): CreatedOfflineProject {
  if (findTenant({ projectSlug: input.slug })) {
    throw new OfflineConflictError(`Project slug '${input.slug}' already exists`);
  }
  const createdAt = new Date();
  const generated = generateApiKey(input.slug);
  const project: Project = {
    id: randomUUID(),
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    upstreamUrl: input.upstreamUrl,
    monthlyBudgetCredits: input.monthlyBudgetCredits,
    creditUnitPriceUsd: '0.001000',
    infraCostPerReqUsd: '0.000150',
    isShowcaseTenant: false,
    createdAt,
  };
  const apiKey: ApiKey = {
    id: randomUUID(),
    projectId: project.id,
    name: 'Default Key',
    keyPrefix: generated.keyPrefix,
    keyHash: generated.keyHash,
    isActive: true,
    createdAt,
  };
  const rules: RateLimitRule[] = DEFAULT_RULE_SPECS.map((r) => ({ ...r, id: randomUUID(), projectId: project.id, httpMethod: 'ALL', createdAt }));
  const wallet: OfflineAccount = {
    id: randomUUID(),
    projectId: project.id,
    accountCode: `WALLET:${input.slug}`,
    accountType: 'ASSET_PREPAID_WALLET',
    balanceCredits: 0,
  };
  const tenant: OfflineTenant = { project, apiKey, rules, wallet, ledger: [], usage: emptyUsage() };

  postTransaction(tenant, equityAccount, wallet, input.monthlyBudgetCredits, `Initial prepaid credit grant for ${input.slug}`);
  tenantsByKeyHash.set(apiKey.keyHash, tenant);
  tenantsByProjectId.set(project.id, tenant);

  return {
    project,
    apiKey: generated.rawKey,
    apiKeyId: apiKey.id,
    keyPrefix: apiKey.keyPrefix,
    walletAccountId: wallet.id,
    initialCredits: input.monthlyBudgetCredits,
    rateLimitRules: rules,
  };
}

export interface UpsertOfflineRuleInput extends ProjectRef, RuleSpec {
  id?: string;
  httpMethod: string;
}

export type UpsertOfflineRuleResult =
  | { status: 'created' | 'updated'; rule: RateLimitRule }
  | { status: 'project_not_found' | 'rule_not_found' };

/** Adds a rule, or updates it by `id` (or by routePattern + httpMethod). */
export function upsertOfflineRule(input: UpsertOfflineRuleInput): UpsertOfflineRuleResult {
  const tenant = findTenant(input);
  if (!tenant) return { status: 'project_not_found' };

  const values = {
    routePattern: input.routePattern,
    httpMethod: input.httpMethod,
    algorithm: input.algorithm,
    limitCount: input.limitCount,
    windowSec: input.windowSec,
    burstCapacity: input.burstCapacity,
    costWeightCredits: input.costWeightCredits,
    priority: input.priority,
  };
  const existing = input.id
    ? tenant.rules.find((r) => r.id === input.id)
    : tenant.rules.find((r) => r.routePattern === values.routePattern && r.httpMethod === values.httpMethod);
  if (input.id && !existing) return { status: 'rule_not_found' };

  let rule: RateLimitRule;
  let status: 'created' | 'updated';
  if (existing) {
    Object.assign(existing, values);
    rule = existing;
    status = 'updated';
  } else {
    rule = { ...values, id: randomUUID(), projectId: tenant.project.id, createdAt: new Date() };
    tenant.rules.push(rule);
    status = 'created';
  }
  tenant.rules.sort((a, b) => b.priority - a.priority);
  return { status, rule };
}

/** Prepaid top-up: DEBIT SYSTEM:EQUITY_SEED, CREDIT WALLET:<slug>. */
export function topUpOfflineWallet(
  ref: ProjectRef,
  amountCredits: number,
): { transactionId: string; walletBalanceCredits: number } | null {
  const tenant = findTenant(ref);
  if (!tenant) return null;
  const transactionId = postTransaction(tenant, equityAccount, tenant.wallet, amountCredits, `Wallet top-up (+${amountCredits} credits)`);
  return { transactionId, walletBalanceCredits: tenant.wallet.balanceCredits };
}

/** Full in-memory journal (chronological per project) and every account balance, for audits. */
export function getOfflineLedgerState(): {
  accounts: { id: string; accountCode: string; balanceCredits: number }[];
  entries: LedgerEntry[];
} {
  const tenants = [...tenantsByProjectId.values()];
  return {
    accounts: [equityAccount, revenueAccount, ...tenants.map((t) => t.wallet)].map(({ id, accountCode, balanceCredits }) => ({
      id,
      accountCode,
      balanceCredits,
    })),
    entries: tenants.flatMap((t) => t.ledger.map((e) => ({ ...e }))),
  };
}

/**
 * Removes a custom tenant with its key, rules, wallet and journal (mirrors the Postgres cascade) and
 * reverses that journal's effect on the platform accounts so all balances still match the ledger.
 */
export function deleteOfflineProject(projectId: string): 'deleted' | 'not_found' | 'protected' {
  const tenant = tenantsByProjectId.get(projectId);
  if (!tenant) return 'not_found';
  if (tenant.project.isShowcaseTenant) return 'protected';
  for (const e of tenant.ledger) {
    const account = e.accountId === equityAccount.id ? equityAccount : e.accountId === revenueAccount.id ? revenueAccount : null;
    if (account) account.balanceCredits -= e.direction === 'CREDIT' ? e.amountCredits : -e.amountCredits;
  }
  tenantsByProjectId.delete(projectId);
  tenantsByKeyHash.delete(tenant.apiKey.keyHash);
  deletedProjectIds.add(projectId);
  return 'deleted';
}

/** Deletes a rule by id. The last `*` rule of a project is kept so it always has a baseline limit. */
export function deleteOfflineRule(ruleId: string): 'deleted' | 'not_found' | 'last_wildcard' {
  for (const tenant of tenantsByProjectId.values()) {
    const index = tenant.rules.findIndex((r) => r.id === ruleId);
    if (index < 0) continue;
    const isLastWildcard = tenant.rules[index]!.routePattern === '*' && tenant.rules.filter((r) => r.routePattern === '*').length === 1;
    if (isLastWildcard) return 'last_wildcard';
    tenant.rules.splice(index, 1);
    return 'deleted';
  }
  return 'not_found';
}
