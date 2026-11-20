import { createMemoryStore, type MemoryStore, type UsageLogEvent } from '@aegisgate/shared';
import { uuid } from './engine-utils';
import { percentile } from './format';
import { LocalLedger, type LocalAccount } from './local-ledger';
import type { ApiKeyView, FinOpsView, ProjectCore, RouteStatView, RuleView } from './types';

export const MAX_BATCH_SIZE = 500;
export const FLUSH_INTERVAL_MS = 5_000;
export const RECENT_EVENTS_CAPACITY = 200;
const MAX_LATENCY_SAMPLES = 2_000;

export interface LocalUsage {
  total: number;
  allowed: number;
  blocked: number;
  credits: number;
  latencies: number[];
  routes: Map<string, RouteStatView>;
}

export interface LocalTenant {
  project: ProjectCore;
  apiKey: ApiKeyView;
  rawKey: string;
  rules: RuleView[];
  wallet: LocalAccount;
  usage: LocalUsage;
  /** Credits charged at the edge but not yet settled into the ledger. */
  unsettled: number;
}

export interface SandboxState {
  byId: Map<string, LocalTenant>;
  byKey: Map<string, LocalTenant>;
  revenue: LocalAccount;
  equity: LocalAccount;
  ledger: LocalLedger;
  limiter: MemoryStore;
  pending: UsageLogEvent[];
  /** Newest first. */
  recent: UsageLogEvent[];
  totalBatchesFlushed: number;
  lastFlushAt: number;
}

export function createState(): SandboxState {
  return {
    byId: new Map(),
    byKey: new Map(),
    revenue: { id: uuid(), code: 'PLATFORM:REVENUE', balance: 0 },
    equity: { id: uuid(), code: 'SYSTEM:EQUITY_SEED', balance: 0 },
    ledger: new LocalLedger(),
    limiter: createMemoryStore(),
    pending: [],
    recent: [],
    totalBatchesFlushed: 0,
    lastFlushAt: Date.now(),
  };
}

export const emptyUsage = (): LocalUsage => ({ total: 0, allowed: 0, blocked: 0, credits: 0, latencies: [], routes: new Map() });

export function recordUsage(usage: LocalUsage, route: string, statusCode: number, latencyMs: number, costCredits: number): void {
  const stat = usage.routes.get(route) ?? { route, totalRequests: 0, allowedRequests: 0, blockedRequests: 0, creditsConsumed: 0 };
  usage.routes.set(route, stat);
  usage.total++;
  stat.totalRequests++;
  if (statusCode < 400) {
    usage.allowed++;
    usage.credits += costCredits;
    stat.allowedRequests++;
    stat.creditsConsumed += costCredits;
  } else {
    usage.blocked++;
    stat.blockedRequests++;
  }
  usage.latencies.push(latencyMs);
  if (usage.latencies.length > MAX_LATENCY_SAMPLES) usage.latencies.splice(0, usage.latencies.length - MAX_LATENCY_SAMPLES);
}

export const routeStatsOf = (usage: LocalUsage): RouteStatView[] =>
  [...usage.routes.values()].sort((a, b) => b.totalRequests - a.totalRequests).slice(0, 20).map((r) => ({ ...r }));

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Same formula as the gateway: revenue = credits × unit price, infra = requests × infra cost/req. */
export function finOpsOf(usage: LocalUsage, creditUnitPriceUsd: number, infraCostPerReqUsd: number): FinOpsView {
  const revenue = round(usage.credits * creditUnitPriceUsd, 6);
  const infra = round(usage.total * infraCostPerReqUsd, 6);
  return {
    totalRequests: usage.total,
    allowedRequests: usage.allowed,
    blockedRequests: usage.blocked,
    p95LatencyMs: round(percentile(usage.latencies, 95), 2),
    creditsConsumed: usage.credits,
    grossRevenueUsd: revenue,
    infraCostUsd: infra,
    grossMarginPct: revenue > 0 ? round(((revenue - infra) / revenue) * 100, 2) : 0,
  };
}
