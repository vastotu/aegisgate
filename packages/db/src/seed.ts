import { randomUUID } from 'node:crypto';
import { hashApiKey } from '@aegisgate/shared';
import { inArray, isNull, sql } from 'drizzle-orm';
import { db, queryClient } from './client';
import { recordDoubleEntryTransaction } from './ledger';
import {
  apiKeys,
  apiUsageLogs,
  ledgerAccounts,
  projects,
  rateLimitRules,
  type NewApiUsageLog,
  type NewRateLimitRule,
} from './schema';

const PLATFORM_REVENUE_CODE = 'PLATFORM:REVENUE';
const SYSTEM_EQUITY_SEED_CODE = 'SYSTEM:EQUITY_SEED';
const USAGE_LOGS_PER_PROJECT = 150;

type RuleSeed = Pick<
  NewRateLimitRule,
  'routePattern' | 'algorithm' | 'limitCount' | 'windowSec' | 'burstCapacity' | 'costWeightCredits' | 'priority'
>;

interface ShowcaseProject {
  name: string;
  slug: string;
  description: string;
  upstreamUrl: string;
  monthlyBudgetCredits: number;
  demoKey: string;
  rules: RuleSeed[];
  /** Concrete routes used to generate historical traffic, with HTTP method and credit cost. */
  traffic: { route: string; method: string; cost: number }[];
}

const SHOWCASE_PROJECTS: ShowcaseProject[] = [
  {
    name: 'HappyShark.io Game Server',
    slug: 'happyshark',
    description: 'Real-time multiplayer game server with room joins and WebSocket frame relays.',
    upstreamUrl: 'https://happyshark.io',
    monthlyBudgetCredits: 500000,
    demoKey: 'ag_live_happyshark_demo_key_2026',
    rules: [
      { routePattern: '/api/room/join', algorithm: 'token_bucket', limitCount: 20, windowSec: 60, burstCapacity: 30, costWeightCredits: 5, priority: 10 },
      { routePattern: '/ws/frame', algorithm: 'sliding_window', limitCount: 60, windowSec: 1, burstCapacity: 60, costWeightCredits: 1, priority: 10 },
      { routePattern: '*', algorithm: 'token_bucket', limitCount: 120, windowSec: 60, burstCapacity: 150, costWeightCredits: 1, priority: 0 },
    ],
    traffic: [
      { route: '/api/room/join', method: 'POST', cost: 5 },
      { route: '/ws/frame', method: 'GET', cost: 1 },
      { route: '/api/leaderboard', method: 'GET', cost: 1 },
      { route: '/api/player/profile', method: 'GET', cost: 1 },
    ],
  },
  {
    name: 'Fintech Market Dashboard',
    slug: 'fintech-dash',
    description: 'Market quote streaming and Monte Carlo risk reporting dashboard.',
    upstreamUrl: 'https://fintech-dashboard.example.com',
    monthlyBudgetCredits: 250000,
    demoKey: 'ag_live_fintech_demo_key_2026',
    rules: [
      { routePattern: '/api/market/quote', algorithm: 'sliding_window', limitCount: 30, windowSec: 60, burstCapacity: 30, costWeightCredits: 2, priority: 10 },
      { routePattern: '/api/report/monte-carlo', algorithm: 'token_bucket', limitCount: 5, windowSec: 60, burstCapacity: 5, costWeightCredits: 50, priority: 10 },
    ],
    traffic: [
      { route: '/api/market/quote', method: 'GET', cost: 2 },
      { route: '/api/report/monte-carlo', method: 'POST', cost: 50 },
    ],
  },
  {
    name: 'AI Copilot & Sandbox API',
    slug: 'ai-sandbox',
    description: 'LLM chat completions sandbox with high per-request credit weight.',
    upstreamUrl: 'https://api.example.com',
    monthlyBudgetCredits: 50000,
    demoKey: 'ag_live_aisandbox_demo_key_2026',
    rules: [
      { routePattern: '/v1/chat/completions', algorithm: 'token_bucket', limitCount: 10, windowSec: 60, burstCapacity: 15, costWeightCredits: 100, priority: 10 },
    ],
    traffic: [{ route: '/v1/chat/completions', method: 'POST', cost: 100 }],
  },
];

/** Small deterministic PRNG (mulberry32) so seeded telemetry is reproducible. */
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

function buildUsageLogs(projectId: string, project: ShowcaseProject, rng: () => number): NewApiUsageLog[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const logs: NewApiUsageLog[] = [];

  for (let i = 0; i < USAGE_LOGS_PER_PROJECT; i++) {
    const target = project.traffic[Math.floor(rng() * project.traffic.length)]!;
    const blocked = rng() < 0.18;
    const latency = 1.1 + rng() * (4.8 - 1.1);
    const ipPool = rng() < 0.5 ? '203.0.113' : '198.51.100';

    logs.push({
      requestId: `req_${randomUUID().replace(/-/g, '')}`,
      projectId,
      route: target.route,
      method: target.method,
      statusCode: blocked ? 429 : 200,
      latencyMs: latency.toFixed(2),
      costCredits: blocked ? 0 : target.cost,
      clientIp: `${ipPool}.${1 + Math.floor(rng() * 254)}`,
      blockedReason: blocked ? 'RATE_LIMIT_EXCEEDED' : null,
      createdAt: new Date(now - Math.floor(rng() * dayMs)),
    });
  }

  return logs;
}

async function upsertGlobalAccount(accountCode: string, accountType: string): Promise<string> {
  const [row] = await db
    .insert(ledgerAccounts)
    .values({ accountCode, accountType, projectId: null })
    .onConflictDoUpdate({ target: ledgerAccounts.accountCode, set: { accountType } })
    .returning({ id: ledgerAccounts.id });
  return row!.id;
}

async function main(): Promise<void> {
  console.log('[seed] Resetting showcase tenants...');
  // Cascades to api keys, rules, wallets, ledger entries and usage logs.
  await db.delete(projects).where(
    inArray(
      projects.slug,
      SHOWCASE_PROJECTS.map((p) => p.slug),
    ),
  );

  const revenueAccountId = await upsertGlobalAccount(PLATFORM_REVENUE_CODE, 'REVENUE_PLATFORM_FEES');
  const equityAccountId = await upsertGlobalAccount(SYSTEM_EQUITY_SEED_CODE, 'EQUITY_SYSTEM_SEED');

  // Re-derive global balances from surviving journal entries so re-runs stay idempotent.
  await db
    .update(ledgerAccounts)
    .set({
      balanceCredits: sql`COALESCE((
        SELECT SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_credits ELSE -e.amount_credits END)
        FROM ledger_entries e WHERE e.account_id = ${ledgerAccounts.id}
      ), 0)`,
      updatedAt: new Date(),
    })
    .where(isNull(ledgerAccounts.projectId));

  const rng = createRng(20260101);

  for (const project of SHOWCASE_PROJECTS) {
    const [created] = await db
      .insert(projects)
      .values({
        name: project.name,
        slug: project.slug,
        description: project.description,
        upstreamUrl: project.upstreamUrl,
        monthlyBudgetCredits: project.monthlyBudgetCredits,
        isShowcaseTenant: true,
      })
      .returning({ id: projects.id });
    const projectId = created!.id;

    await db.insert(rateLimitRules).values(project.rules.map((rule) => ({ ...rule, projectId })));

    await db.insert(apiKeys).values({
      projectId,
      name: 'Showcase Demo Key',
      keyPrefix: `${project.demoKey.slice(0, 16)}...`,
      keyHash: hashApiKey(project.demoKey),
    });

    const [wallet] = await db
      .insert(ledgerAccounts)
      .values({
        projectId,
        accountCode: `WALLET:${project.slug}`,
        accountType: 'ASSET_PREPAID_WALLET',
      })
      .returning({ id: ledgerAccounts.id });

    // Fund the wallet: equity seed decreases, prepaid wallet increases.
    await recordDoubleEntryTransaction(db, {
      projectId,
      debitAccountId: equityAccountId,
      creditAccountId: wallet!.id,
      amountCredits: project.monthlyBudgetCredits,
      description: `Initial prepaid credit grant for ${project.slug}`,
    });

    await db.insert(apiUsageLogs).values(buildUsageLogs(projectId, project, rng));

    console.log(`[seed] ${project.slug}: ${project.rules.length} rules, 1 key, ${project.monthlyBudgetCredits} credits, ${USAGE_LOGS_PER_PROJECT} usage logs`);
  }

  console.log(`[seed] Global accounts ready (revenue=${revenueAccountId}, equity=${equityAccountId})`);
  console.log('[seed] Done.');
}

main()
  .catch((err) => {
    console.error('[seed] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await queryClient.end();
  });
