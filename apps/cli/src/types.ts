import type { UsageLogEvent } from '@aegisgate/shared';

// Subset of the gateway's GET /v1/admin/overview payload used by `aegis top`.

export interface OverviewFinOps {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  p95LatencyMs: number;
  creditsConsumed: number;
  grossRevenueUsd: number;
  infraCostUsd: number;
  grossMarginPct: number;
}

export interface OverviewLedgerEntry {
  id: string;
  projectId: string;
  direction: string;
  amountCredits: number;
  balanceAfter: number;
  description: string;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

export interface OverviewProject {
  id: string;
  name: string;
  slug: string;
  monthlyBudgetCredits: number;
  isShowcaseTenant: boolean;
  demoApiKey: string | null;
  walletBalanceCredits: number;
  pendingUnsettledCredits: number;
  recentLedgerEntries: OverviewLedgerEntry[];
  finops: OverviewFinOps;
}

export interface OverviewResponse {
  generatedAt: string;
  degraded: boolean;
  dataSource?: string;
  error?: string;
  projects: OverviewProject[];
  platform: { revenueBalanceCredits: number; finops: OverviewFinOps };
  worker: {
    bufferSize: number;
    maxBufferSize: number;
    totalBatchesFlushed: number;
    recentLiveEvents: UsageLogEvent[];
  };
}
