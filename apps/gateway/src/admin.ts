import { createHash, timingSafeEqual } from 'node:crypto';
import {
  apiKeys,
  apiUsageLogs,
  db,
  ledgerAccounts,
  ledgerEntries,
  projects,
  rateLimitRules,
  recordDoubleEntryTransaction,
  type LedgerEntry,
  type Project,
  type RateLimitRule,
} from '@aegisgate/db';
import { generateApiKey, RateLimitAlgoSchema } from '@aegisgate/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { flushBatch, getUnsettledCredits, getWorkerMetrics } from './batch-worker';
import { isDatabaseUnavailable, pgErrorCode } from './db-errors';
import { SHOWCASE_DEMO_KEYS } from './demo-keys';
import {
  createOfflineProject,
  deleteOfflineProject,
  deleteOfflineRule,
  getOfflineSnapshot,
  OfflineConflictError,
  topUpOfflineWallet,
  upsertOfflineRule,
  type RouteStat,
} from './showcase-fallback';
import { invalidateTenantCache } from './tenant-cache';

export const ADMIN_SECRET_HEADER = 'x-aegis-admin-secret';
/** Local-dev fallback when AEGIS_ADMIN_SECRET is unset. Always set a real secret in deployed environments. */
const DEFAULT_ADMIN_SECRET = 'ag_admin_master_secret_2026';

const PLATFORM_REVENUE_CODE = 'PLATFORM:REVENUE';
const SYSTEM_EQUITY_SEED_CODE = 'SYSTEM:EQUITY_SEED';
const HTTP_METHODS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

function isAuthorized(provided: string | string[] | undefined): boolean {
  const expected = process.env.AEGIS_ADMIN_SECRET || DEFAULT_ADMIN_SECRET;
  if (typeof provided !== 'string') return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

/** preHandler for state-mutating admin routes only. */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (isAuthorized(request.headers[ADMIN_SECRET_HEADER])) return undefined;
  return reply.code(401).send({ error: 'Unauthorized', reason: `Missing or invalid ${ADMIN_SECRET_HEADER} header` });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

async function ensureGlobalAccount(accountCode: string, accountType: string): Promise<string> {
  await db.insert(ledgerAccounts).values({ accountCode, accountType, projectId: null }).onConflictDoNothing();
  const [row] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.accountCode, accountCode))
    .limit(1);
  if (!row) throw new Error(`Failed to ensure ledger account ${accountCode}`);
  return row.id;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

interface FinOps {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  p95LatencyMs: number;
  creditsConsumed: number;
  grossRevenueUsd: number;
  infraCostUsd: number;
  grossMarginPct: number;
}

interface ProjectOverview extends Project {
  apiKeys: { id: string; name: string; keyPrefix: string; isActive: boolean; createdAt: Date }[];
  demoApiKey: string | null;
  rateLimitRules: RateLimitRule[];
  walletAccountId: string | null;
  walletBalanceCredits: number;
  pendingUnsettledCredits: number;
  recentLedgerEntries: LedgerEntry[];
  finops: FinOps;
  /** Per-route usage (top 20 by volume) for unit-economics breakdowns. */
  routeStats: RouteStat[];
}

interface Overview {
  generatedAt: string;
  degraded: boolean;
  dataSource: 'postgres' | 'offline-showcase';
  error?: string;
  projects: ProjectOverview[];
  platform: { revenueBalanceCredits: number; finops: FinOps };
}

const EMPTY_FINOPS: FinOps = {
  totalRequests: 0,
  allowedRequests: 0,
  blockedRequests: 0,
  p95LatencyMs: 0,
  creditsConsumed: 0,
  grossRevenueUsd: 0,
  infraCostUsd: 0,
  grossMarginPct: 0,
};

const usageAggregates = {
  totalRequests: sql<number>`count(*)`.mapWith(Number),
  allowedRequests: sql<number>`count(*) filter (where ${apiUsageLogs.statusCode} < 400)`.mapWith(Number),
  blockedRequests: sql<number>`count(*) filter (where ${apiUsageLogs.statusCode} >= 400)`.mapWith(Number),
  p95LatencyMs: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${apiUsageLogs.latencyMs}), 0)`.mapWith(Number),
  creditsConsumed: sql<number>`coalesce(sum(${apiUsageLogs.costCredits}) filter (where ${apiUsageLogs.statusCode} < 400), 0)`.mapWith(Number),
};

function computeFinOps(
  usage: Pick<FinOps, 'totalRequests' | 'allowedRequests' | 'blockedRequests' | 'p95LatencyMs' | 'creditsConsumed'>,
  grossRevenueUsd: number,
  infraCostUsd: number,
): FinOps {
  const revenue = round(grossRevenueUsd, 6);
  const infra = round(infraCostUsd, 6);
  return {
    ...usage,
    p95LatencyMs: round(usage.p95LatencyMs, 2),
    grossRevenueUsd: revenue,
    infraCostUsd: infra,
    grossMarginPct: revenue > 0 ? round(((revenue - infra) / revenue) * 100, 2) : 0,
  };
}

async function buildOverview(): Promise<Overview> {
  const { p95LatencyMs: _p95, ...routeAggregates } = usageAggregates;
  const [projectRows, keyRows, ruleRows, accountRows, usageRows, [platformUsage], routeRows] = await Promise.all([
    db.select().from(projects).orderBy(asc(projects.createdAt)),
    db
      .select({
        id: apiKeys.id,
        projectId: apiKeys.projectId,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        isActive: apiKeys.isActive,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .orderBy(asc(apiKeys.createdAt)),
    db.select().from(rateLimitRules).orderBy(desc(rateLimitRules.priority), asc(rateLimitRules.createdAt)),
    db.select().from(ledgerAccounts),
    db
      .select({ projectId: apiUsageLogs.projectId, ...usageAggregates })
      .from(apiUsageLogs)
      .groupBy(apiUsageLogs.projectId),
    db.select(usageAggregates).from(apiUsageLogs),
    db
      .select({ projectId: apiUsageLogs.projectId, route: apiUsageLogs.route, ...routeAggregates })
      .from(apiUsageLogs)
      .groupBy(apiUsageLogs.projectId, apiUsageLogs.route),
  ]);

  const ledgerByProject = await Promise.all(
    projectRows.map((p) =>
      db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.projectId, p.id))
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(30),
    ),
  );

  const usageByProject = new Map(usageRows.map((u) => [u.projectId, u]));
  let totalRevenueUsd = 0;
  let totalInfraUsd = 0;

  const projectOverviews: ProjectOverview[] = projectRows.map((p, i) => {
    const { projectId: _ignored, ...usage } = usageByProject.get(p.id) ?? { projectId: p.id, ...EMPTY_FINOPS };
    const revenueUsd = usage.creditsConsumed * Number(p.creditUnitPriceUsd);
    const infraUsd = usage.totalRequests * Number(p.infraCostPerReqUsd);
    totalRevenueUsd += revenueUsd;
    totalInfraUsd += infraUsd;

    const wallet = accountRows.find((a) => a.accountCode === `WALLET:${p.slug}`);
    return {
      ...p,
      apiKeys: keyRows.filter((k) => k.projectId === p.id).map(({ projectId: _p, ...k }) => k),
      demoApiKey: p.isShowcaseTenant ? (SHOWCASE_DEMO_KEYS[p.slug] ?? null) : null,
      rateLimitRules: ruleRows.filter((r) => r.projectId === p.id),
      walletAccountId: wallet?.id ?? null,
      walletBalanceCredits: wallet?.balanceCredits ?? 0,
      pendingUnsettledCredits: getUnsettledCredits(p.id),
      recentLedgerEntries: ledgerByProject[i] ?? [],
      finops: computeFinOps(usage, revenueUsd, infraUsd),
      routeStats: routeRows
        .filter((r) => r.projectId === p.id)
        .map(({ projectId: _pid, ...r }) => r)
        .sort((a, b) => b.totalRequests - a.totalRequests)
        .slice(0, 20),
    };
  });

  const revenueAccount = accountRows.find((a) => a.accountCode === PLATFORM_REVENUE_CODE);
  return {
    generatedAt: new Date().toISOString(),
    degraded: false,
    dataSource: 'postgres',
    projects: projectOverviews,
    platform: {
      revenueBalanceCredits: revenueAccount?.balanceCredits ?? 0,
      finops: computeFinOps(platformUsage ?? EMPTY_FINOPS, totalRevenueUsd, totalInfraUsd),
    },
  };
}

/** Same shape as buildOverview, sourced from the in-memory showcase replica while Postgres is down. */
function buildOfflineOverview(): Overview {
  const snapshot = getOfflineSnapshot();
  let totalRevenueUsd = 0;
  let totalInfraUsd = 0;

  const projectOverviews: ProjectOverview[] = snapshot.tenants.map((t) => {
    const revenueUsd = t.usage.creditsConsumed * Number(t.project.creditUnitPriceUsd);
    const infraUsd = t.usage.totalRequests * Number(t.project.infraCostPerReqUsd);
    totalRevenueUsd += revenueUsd;
    totalInfraUsd += infraUsd;
    const { id, name, keyPrefix, isActive, createdAt } = t.apiKey;
    return {
      ...t.project,
      apiKeys: [{ id, name, keyPrefix, isActive, createdAt }],
      demoApiKey: SHOWCASE_DEMO_KEYS[t.project.slug] ?? null,
      rateLimitRules: t.rules,
      walletAccountId: t.walletAccountId,
      walletBalanceCredits: t.walletBalanceCredits,
      pendingUnsettledCredits: getUnsettledCredits(t.project.id),
      recentLedgerEntries: t.recentLedgerEntries,
      finops: computeFinOps(t.usage, revenueUsd, infraUsd),
      routeStats: t.routeStats,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    degraded: true,
    dataSource: 'offline-showcase',
    error: 'DATABASE_UNAVAILABLE',
    projects: projectOverviews,
    platform: {
      revenueBalanceCredits: snapshot.revenueBalanceCredits,
      finops: computeFinOps(snapshot.platformUsage, totalRevenueUsd, totalInfraUsd),
    },
  };
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'slug must be 2-48 chars of a-z, 0-9 or -'),
  upstreamUrl: z
    .string()
    .url()
    .max(512)
    .refine((u) => /^https?:\/\//i.test(u), 'upstreamUrl must be http(s)'),
  description: z.string().max(2000).optional(),
  monthlyBudgetCredits: z.number().int().positive().max(1_000_000_000_000).default(100_000),
});

const UpsertRuleSchema = z
  .object({
    id: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    projectSlug: z.string().min(1).max(64).optional(),
    routePattern: z
      .string()
      .trim()
      .max(255)
      .regex(/^(\*|\/[^*]*\*?)$/, "routePattern must be '*', an exact path, or a prefix ending in '*'"),
    httpMethod: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.enum(HTTP_METHODS))
      .default('ALL'),
    algorithm: RateLimitAlgoSchema.default('token_bucket'),
    limitCount: z.number().int().min(1).max(1_000_000),
    windowSec: z.number().int().min(1).max(86_400),
    burstCapacity: z.number().int().min(1).max(1_000_000).optional(),
    costWeightCredits: z.number().int().min(0).max(1_000_000).default(1),
    priority: z.number().int().min(-1000).max(1000).default(0),
  })
  .refine((v) => v.projectId || v.projectSlug, { message: 'projectId or projectSlug is required' });

const TopUpSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    projectSlug: z.string().min(1).max(64).optional(),
    amountCredits: z.number().int().min(1).max(100_000_000).default(10_000),
  })
  .refine((v) => v.projectId || v.projectSlug, { message: 'projectId or projectSlug is required' });

type UpsertRuleInput = z.infer<typeof UpsertRuleSchema>;
type RuleValues = Omit<UpsertRuleInput, 'id' | 'projectId' | 'projectSlug' | 'burstCapacity'> & { burstCapacity: number };
type UpsertResult =
  | { status: 'created' | 'updated'; rule: RateLimitRule }
  | { status: 'project_not_found' | 'rule_not_found' };

async function upsertRuleInDb(input: UpsertRuleInput, values: RuleValues): Promise<UpsertResult> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(input.projectId ? eq(projects.id, input.projectId) : eq(projects.slug, input.projectSlug!))
    .limit(1);
  if (!project) return { status: 'project_not_found' };

  let targetId = input.id;
  if (!targetId) {
    const [existing] = await db
      .select({ id: rateLimitRules.id })
      .from(rateLimitRules)
      .where(
        and(
          eq(rateLimitRules.projectId, project.id),
          eq(rateLimitRules.routePattern, values.routePattern),
          eq(rateLimitRules.httpMethod, values.httpMethod),
        ),
      )
      .limit(1);
    targetId = existing?.id;
  }

  if (targetId) {
    const [rule] = await db
      .update(rateLimitRules)
      .set(values)
      .where(and(eq(rateLimitRules.id, targetId), eq(rateLimitRules.projectId, project.id)))
      .returning();
    return rule ? { status: 'updated', rule } : { status: 'rule_not_found' };
  }
  const [rule] = await db
    .insert(rateLimitRules)
    .values({ ...values, projectId: project.id })
    .returning();
  return { status: 'created', rule: rule! };
}

const SHOWCASE_DELETE_ERROR = 'Builtin showcase tenants cannot be deleted, only custom projects can be removed.';
const LAST_WILDCARD_ERROR = "The last '*' fallback rule cannot be deleted: every project keeps a baseline rule.";
const ProjectIdParamSchema = z.object({ projectId: z.string().uuid() });
const RuleIdParamSchema = z.object({ ruleId: z.string().uuid() });

async function deleteProjectInDb(projectId: string): Promise<'deleted' | 'not_found' | 'protected'> {
  const [project] = await db
    .select({ isShowcaseTenant: projects.isShowcaseTenant })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return 'not_found';
  if (project.isShowcaseTenant) return 'protected';

  await db.transaction(async (tx) => {
    // Same lock order as recordDoubleEntryTransaction: project advisory lock first, then accounts by id.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`);
    await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(isNull(ledgerAccounts.projectId))
      .orderBy(asc(ledgerAccounts.id))
      .for('update');
    // Cascades to api_keys, rate_limit_rules, WALLET:<slug>, ledger_entries and api_usage_logs.
    await tx.delete(projects).where(eq(projects.id, projectId));
    // Re-derive platform account balances from the surviving journal so balances still match the ledger.
    await tx
      .update(ledgerAccounts)
      .set({
        balanceCredits: sql`COALESCE((
          SELECT SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_credits ELSE -e.amount_credits END)
          FROM ledger_entries e WHERE e.account_id = ${ledgerAccounts.id}
        ), 0)`,
        updatedAt: new Date(),
      })
      .where(isNull(ledgerAccounts.projectId));
  });
  return 'deleted';
}

async function deleteRuleInDb(ruleId: string): Promise<'deleted' | 'not_found' | 'last_wildcard'> {
  const [rule] = await db
    .select({ projectId: rateLimitRules.projectId, routePattern: rateLimitRules.routePattern })
    .from(rateLimitRules)
    .where(eq(rateLimitRules.id, ruleId))
    .limit(1);
  if (!rule) return 'not_found';
  if (rule.routePattern === '*') {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(rateLimitRules)
      .where(and(eq(rateLimitRules.projectId, rule.projectId), eq(rateLimitRules.routePattern, '*')));
    if (count <= 1) return 'last_wildcard';
  }
  await db.delete(rateLimitRules).where(eq(rateLimitRules.id, ruleId));
  return 'deleted';
}

const DEFAULT_PROJECT_RULES = [
  {
    routePattern: '*',
    httpMethod: 'ALL',
    algorithm: 'token_bucket',
    limitCount: 100,
    windowSec: 60,
    burstCapacity: 120,
    costWeightCredits: 1,
    priority: 0,
  },
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (admin) => {
      // Public read-only showcase endpoint (no admin secret).
      admin.get('/overview', async (request) => {
        try {
          return { ...(await buildOverview()), worker: getWorkerMetrics() };
        } catch (err) {
          if (!isDatabaseUnavailable(err)) throw err;
          request.log.warn({ code: pgErrorCode(err) }, 'overview: database unavailable, serving offline showcase data');
          return { ...buildOfflineOverview(), worker: getWorkerMetrics() };
        }
      });

      admin.post('/projects', { preHandler: requireAdmin }, async (request, reply) => {
        const parsed = CreateProjectSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
        const input = parsed.data;
        const generated = generateApiKey(input.slug);

        let created: { project: Project; apiKeyId: string; walletAccountId: string; rules: RateLimitRule[] };
        try {
          created = await db.transaction(async (tx) => {
            const [project] = await tx
              .insert(projects)
              .values({
                name: input.name,
                slug: input.slug,
                description: input.description,
                upstreamUrl: input.upstreamUrl,
                monthlyBudgetCredits: input.monthlyBudgetCredits,
              })
              .returning();
            const [key] = await tx
              .insert(apiKeys)
              .values({ projectId: project!.id, name: 'Default Key', keyPrefix: generated.keyPrefix, keyHash: generated.keyHash })
              .returning({ id: apiKeys.id });
            const [wallet] = await tx
              .insert(ledgerAccounts)
              .values({ projectId: project!.id, accountCode: `WALLET:${input.slug}`, accountType: 'ASSET_PREPAID_WALLET' })
              .returning({ id: ledgerAccounts.id });
            const rules = await tx
              .insert(rateLimitRules)
              .values(DEFAULT_PROJECT_RULES.map((r) => ({ ...r, projectId: project!.id })))
              .returning();
            return { project: project!, apiKeyId: key!.id, walletAccountId: wallet!.id, rules };
          });
        } catch (err) {
          if (pgErrorCode(err) === '23505') {
            return reply.code(409).send({ error: 'Conflict', reason: `Project slug '${input.slug}' already exists` });
          }
          if (!isDatabaseUnavailable(err)) throw err;
          // Postgres down: onboard the project into the in-memory showcase store instead.
          try {
            const offline = createOfflineProject(input);
            invalidateTenantCache();
            return reply.code(201).send({ ...offline, dataSource: 'offline-showcase' });
          } catch (offlineErr) {
            if (offlineErr instanceof OfflineConflictError) {
              return reply.code(409).send({ error: 'Conflict', reason: offlineErr.message });
            }
            throw offlineErr;
          }
        }

        // Fund the wallet: DEBIT SYSTEM:EQUITY_SEED, CREDIT WALLET:<slug>.
        try {
          await ensureGlobalAccount(PLATFORM_REVENUE_CODE, 'REVENUE_PLATFORM_FEES');
          const equityId = await ensureGlobalAccount(SYSTEM_EQUITY_SEED_CODE, 'EQUITY_SYSTEM_SEED');
          await recordDoubleEntryTransaction(db, {
            projectId: created.project.id,
            debitAccountId: equityId,
            creditAccountId: created.walletAccountId,
            amountCredits: input.monthlyBudgetCredits,
            description: `Initial prepaid credit grant for ${input.slug}`,
          });
        } catch (err) {
          await db.delete(projects).where(eq(projects.id, created.project.id));
          throw err;
        }

        invalidateTenantCache();
        return reply.code(201).send({
          project: created.project,
          apiKey: generated.rawKey,
          apiKeyId: created.apiKeyId,
          keyPrefix: generated.keyPrefix,
          walletAccountId: created.walletAccountId,
          initialCredits: input.monthlyBudgetCredits,
          rateLimitRules: created.rules,
        });
      });

      admin.post('/rules', { preHandler: requireAdmin }, async (request, reply) => {
        const parsed = UpsertRuleSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
        const input = parsed.data;

        const values: RuleValues = {
          routePattern: input.routePattern,
          httpMethod: input.httpMethod,
          algorithm: input.algorithm,
          limitCount: input.limitCount,
          windowSec: input.windowSec,
          burstCapacity: input.burstCapacity ?? input.limitCount,
          costWeightCredits: input.costWeightCredits,
          priority: input.priority,
        };

        let result: UpsertResult;
        let dataSource: 'postgres' | 'offline-showcase' = 'postgres';
        try {
          result = await upsertRuleInDb(input, values);
        } catch (err) {
          if (!isDatabaseUnavailable(err)) throw err;
          result = upsertOfflineRule({ id: input.id, projectId: input.projectId, projectSlug: input.projectSlug, ...values });
          dataSource = 'offline-showcase';
        }

        if (!('rule' in result)) {
          const reason = result.status === 'project_not_found' ? 'Project not found' : 'Rule not found for project';
          return reply.code(404).send({ error: 'Not Found', reason });
        }

        invalidateTenantCache();
        return reply.code(result.status === 'created' ? 201 : 200).send({ action: result.status, rule: result.rule, dataSource });
      });

      admin.post('/flush', { preHandler: requireAdmin }, async () => {
        const result = await flushBatch();
        return { ...result, worker: getWorkerMetrics() };
      });

      // Prepaid wallet top-up: DEBIT SYSTEM:EQUITY_SEED, CREDIT WALLET:<slug>.
      admin.post('/wallet/topup', { preHandler: requireAdmin }, async (request, reply) => {
        const parsed = TopUpSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
        const { projectId, projectSlug, amountCredits } = parsed.data;

        try {
          const [row] = await db
            .select({ projectId: projects.id, walletId: ledgerAccounts.id })
            .from(projects)
            .innerJoin(ledgerAccounts, eq(ledgerAccounts.accountCode, sql<string>`'WALLET:' || ${projects.slug}`))
            .where(projectId ? eq(projects.id, projectId) : eq(projects.slug, projectSlug!))
            .limit(1);
          if (!row) return reply.code(404).send({ error: 'Not Found', reason: 'Project wallet not found' });

          const equityId = await ensureGlobalAccount(SYSTEM_EQUITY_SEED_CODE, 'EQUITY_SYSTEM_SEED');
          const tx = await recordDoubleEntryTransaction(db, {
            projectId: row.projectId,
            debitAccountId: equityId,
            creditAccountId: row.walletId,
            amountCredits,
            description: `Wallet top-up (+${amountCredits} credits)`,
          });
          invalidateTenantCache();
          return {
            dataSource: 'postgres',
            transactionId: tx.transactionId,
            amountCredits,
            walletBalanceCredits: tx.creditEntry.balanceAfter,
          };
        } catch (err) {
          if (!isDatabaseUnavailable(err)) throw err;
          const offline = topUpOfflineWallet({ projectId, projectSlug }, amountCredits);
          if (!offline) return reply.code(404).send({ error: 'Not Found', reason: 'Project wallet not found' });
          invalidateTenantCache();
          return { dataSource: 'offline-showcase', amountCredits, ...offline };
        }
      });

      admin.delete('/projects/:projectId', { preHandler: requireAdmin }, async (request, reply) => {
        const parsed = ProjectIdParamSchema.safeParse(request.params);
        if (!parsed.success) return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
        const { projectId } = parsed.data;

        let result: 'deleted' | 'not_found' | 'protected' = 'not_found';
        let dataSource: 'postgres' | 'offline-showcase' = 'postgres';
        try {
          result = await deleteProjectInDb(projectId);
        } catch (err) {
          if (!isDatabaseUnavailable(err)) throw err;
          dataSource = 'offline-showcase';
        }
        // Not in Postgres (or Postgres down): it may live in the in-memory showcase store.
        if (result === 'not_found') {
          const offline = deleteOfflineProject(projectId);
          if (offline !== 'not_found') {
            result = offline;
            dataSource = 'offline-showcase';
          }
        }

        if (result === 'protected') return reply.code(400).send({ error: SHOWCASE_DELETE_ERROR });
        if (result === 'not_found') return reply.code(404).send({ error: 'Not Found', reason: 'Project not found' });
        invalidateTenantCache();
        return { deleted: true, projectId, dataSource };
      });

      admin.delete('/rules/:ruleId', { preHandler: requireAdmin }, async (request, reply) => {
        const parsed = RuleIdParamSchema.safeParse(request.params);
        if (!parsed.success) return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
        const { ruleId } = parsed.data;

        let result: 'deleted' | 'not_found' | 'last_wildcard' = 'not_found';
        let dataSource: 'postgres' | 'offline-showcase' = 'postgres';
        try {
          result = await deleteRuleInDb(ruleId);
        } catch (err) {
          if (!isDatabaseUnavailable(err)) throw err;
          dataSource = 'offline-showcase';
        }
        if (result === 'not_found') {
          const offline = deleteOfflineRule(ruleId);
          if (offline !== 'not_found') {
            result = offline;
            dataSource = 'offline-showcase';
          }
        }

        if (result === 'last_wildcard') return reply.code(409).send({ error: 'Conflict', reason: LAST_WILDCARD_ERROR });
        if (result === 'not_found') return reply.code(404).send({ error: 'Not Found', reason: 'Rule not found' });
        invalidateTenantCache();
        return { deleted: true, ruleId, dataSource };
      });
    },
    { prefix: '/v1/admin' },
  );
}
