import { simulateBurst, sweepMemoryStore, type SimulateBurstRequest, type SimulationResult } from '@aegisgate/shared';
import { evaluateCheck } from './local-check';
import {
  bootstrapState,
  createProjectInState,
  deleteProjectInState,
  deleteRuleInState,
  flushState,
  topUpInState,
  upsertRuleInState,
} from './local-mutations';
import { createState, emptyUsage, finOpsOf, FLUSH_INTERVAL_MS, MAX_BATCH_SIZE, routeStatsOf, type LocalUsage } from './local-state';
import type {
  CheckInput,
  CheckOutcome,
  CreatedProject,
  CreateProjectInput,
  OverviewView,
  ProjectView,
  RuleInput,
  RuleUpsertResult,
} from './types';

/**
 * In-browser edge sandbox: the same algorithms (@aegisgate/shared), tenant model, write-behind
 * buffer and hash-chained double-entry ledger as the gateway, running entirely client-side.
 */
export class LocalEngine {
  private readonly state = createState();
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = bootstrapState(this.state);
  }

  async check(input: CheckInput): Promise<CheckOutcome> {
    await this.ready;
    const outcome = evaluateCheck(this.state, input);
    if (this.state.pending.length >= MAX_BATCH_SIZE) void this.flush();
    return outcome;
  }

  async flush(): Promise<{ flushedEvents: number; settledCredits: number }> {
    await this.ready;
    return flushState(this.state);
  }

  /** Runs the periodic write-behind flush (the gateway does this on a 5s timer). */
  private async tick(): Promise<void> {
    const s = this.state;
    if (s.pending.length > 0 && Date.now() - s.lastFlushAt >= FLUSH_INTERVAL_MS) await flushState(s);
    sweepMemoryStore(s.limiter, Date.now());
  }

  async overview(): Promise<OverviewView> {
    await this.ready;
    await this.tick();
    const s = this.state;
    const platformUsage: LocalUsage = emptyUsage();
    let revenueUsd = 0;
    let infraUsd = 0;

    const projects: ProjectView[] = [...s.byId.values()].map((t) => {
      const price = Number(t.project.creditUnitPriceUsd);
      const infra = Number(t.project.infraCostPerReqUsd);
      const finops = finOpsOf(t.usage, price, infra);
      revenueUsd += finops.grossRevenueUsd;
      infraUsd += finops.infraCostUsd;
      platformUsage.total += t.usage.total;
      platformUsage.allowed += t.usage.allowed;
      platformUsage.blocked += t.usage.blocked;
      platformUsage.credits += t.usage.credits;
      platformUsage.latencies.push(...t.usage.latencies);
      return {
        ...t.project,
        apiKeys: [{ ...t.apiKey }],
        demoApiKey: t.project.isShowcaseTenant ? t.rawKey : null,
        rateLimitRules: t.rules.map((r) => ({ ...r })),
        walletAccountId: t.wallet.id,
        walletBalanceCredits: t.wallet.balance,
        pendingUnsettledCredits: t.unsettled,
        recentLedgerEntries: s.ledger.entries(t.project.id).slice(-30).reverse(),
        finops,
        routeStats: routeStatsOf(t.usage),
      };
    });

    const platformFinops = finOpsOf(platformUsage, 0, 0);
    platformFinops.grossRevenueUsd = Math.round(revenueUsd * 1e6) / 1e6;
    platformFinops.infraCostUsd = Math.round(infraUsd * 1e6) / 1e6;
    platformFinops.grossMarginPct = revenueUsd > 0 ? Math.round(((revenueUsd - infraUsd) / revenueUsd) * 10_000) / 100 : 0;

    return {
      generatedAt: new Date().toISOString(),
      degraded: false,
      dataSource: 'browser-sandbox',
      projects,
      platform: { revenueBalanceCredits: s.revenue.balance, finops: platformFinops },
      worker: {
        bufferSize: s.pending.length,
        maxBufferSize: MAX_BATCH_SIZE,
        totalBatchesFlushed: s.totalBatchesFlushed,
        recentLiveEvents: [...s.recent],
      },
    };
  }

  simulate(req: SimulateBurstRequest): SimulationResult {
    return simulateBurst(req);
  }

  async createProject(input: CreateProjectInput): Promise<CreatedProject> {
    await this.ready;
    return createProjectInState(this.state, input);
  }

  async upsertRule(input: RuleInput): Promise<RuleUpsertResult> {
    await this.ready;
    return upsertRuleInState(this.state, input);
  }

  async topUp(slug: string, amountCredits: number): Promise<number> {
    await this.ready;
    return topUpInState(this.state, slug, amountCredits);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.ready;
    deleteProjectInState(this.state, projectId);
  }

  async deleteRule(projectId: string, ruleId: string): Promise<void> {
    await this.ready;
    deleteRuleInState(this.state, projectId, ruleId);
  }
}
