import type { CheckRateLimitResponse, RateLimitAlgo, UsageLogEvent } from '@aegisgate/shared';

// Mirrors the gateway's GET /v1/admin/overview payload (JSON-serialized: dates are ISO strings).

export type DataSource = 'postgres' | 'offline-showcase' | 'browser-sandbox';
export type ConnectionMode = 'probing' | 'live' | 'sandbox';

export interface RuleView {
  id: string;
  projectId: string;
  routePattern: string;
  httpMethod: string;
  algorithm: string;
  limitCount: number;
  windowSec: number;
  burstCapacity: number;
  costWeightCredits: number;
  priority: number;
  createdAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  projectId: string;
  accountId: string;
  direction: string;
  amountCredits: number;
  balanceAfter: number;
  description: string;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

export interface FinOpsView {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  p95LatencyMs: number;
  creditsConsumed: number;
  grossRevenueUsd: number;
  infraCostUsd: number;
  grossMarginPct: number;
}

export interface RouteStatView {
  route: string;
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  creditsConsumed: number;
}

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  createdAt: string;
}

export interface ProjectCore {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  upstreamUrl: string;
  monthlyBudgetCredits: number;
  creditUnitPriceUsd: string;
  infraCostPerReqUsd: string;
  isShowcaseTenant: boolean;
  createdAt: string;
}

export interface ProjectView extends ProjectCore {
  apiKeys: ApiKeyView[];
  demoApiKey: string | null;
  rateLimitRules: RuleView[];
  walletAccountId: string | null;
  walletBalanceCredits: number;
  pendingUnsettledCredits: number;
  recentLedgerEntries: LedgerEntryView[];
  finops: FinOpsView;
  routeStats?: RouteStatView[];
}

export interface WorkerView {
  bufferSize: number;
  maxBufferSize: number;
  totalBatchesFlushed: number;
  recentLiveEvents: UsageLogEvent[];
}

export interface OverviewView {
  generatedAt: string;
  degraded: boolean;
  dataSource: DataSource;
  error?: string;
  projects: ProjectView[];
  platform: { revenueBalanceCredits: number; finops: FinOpsView };
  worker: WorkerView;
}

export interface CheckInput {
  apiKey: string;
  route: string;
  method: string;
  clientIp: string;
  costOverride?: number;
}

export interface CheckOutcome {
  httpStatus: number;
  body: CheckRateLimitResponse;
  headers: Record<string, string>;
  rttMs: number;
}

export interface TrafficBatchRequest {
  apiKey: string;
  route: string;
  method: string;
  count: number;
  concurrency: number;
  /** One IP per request (e.g. distinct players) or a single attacker IP. */
  clientIp: (index: number) => string;
  /** When set, request i starts at i * paceMs (e.g. 120 pkt/s). */
  paceMs?: number;
}

export interface TrafficBatchResult {
  outcomes: CheckOutcome[];
  mode: 'live' | 'sandbox';
  elapsedMs: number;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  upstreamUrl: string;
  description?: string;
  monthlyBudgetCredits: number;
}

export interface CreatedProject {
  project: { id: string; name: string; slug: string };
  apiKey: string;
  keyPrefix: string;
  initialCredits: number;
}

export interface RuleInput {
  projectSlug: string;
  routePattern: string;
  httpMethod: string;
  algorithm: RateLimitAlgo;
  limitCount: number;
  windowSec: number;
  burstCapacity: number;
  costWeightCredits: number;
  priority: number;
}

export interface RuleUpsertResult {
  action: 'created' | 'updated';
  rule: RuleView;
}

export interface SettlementResult {
  settledCredits: number;
  toppedUpCredits: number;
}
