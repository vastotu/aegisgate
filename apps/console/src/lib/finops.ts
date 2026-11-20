import type { ProjectView, RouteStatView } from './types';

// FinOps cost model (estimates). Revenue comes from billed credits; cost is:
//   upstream cost = allowed requests × base infra cost/req × route compute factor
//   edge cost     = every evaluated request × EDGE_COST_PER_EVAL_USD (blocked ones too)
// Blocked requests never reach the upstream, so their upstream cost counts as saved spend.

export const EDGE_COST_PER_EVAL_USD = 0.000002;

const COMPUTE_PROFILES: { match: RegExp; factor: number; label: string }[] = [
  { match: /chat\/completions|llm|generate|embeddings/i, factor: 800, label: 'GPU inference' },
  { match: /monte-carlo|report|export|pdf|render/i, factor: 250, label: 'Batch compute' },
  { match: /ws\/|frame|heartbeat/i, factor: 0.5, label: 'Realtime relay' },
];

export function computeProfile(route: string): { factor: number; label: string } {
  return COMPUTE_PROFILES.find((p) => p.match.test(route)) ?? { factor: 1, label: 'Standard API' };
}

export interface RouteEconomics extends RouteStatView {
  profile: string;
  blockedPct: number;
  revenueUsd: number;
  infraCostUsd: number;
  savedSpendUsd: number;
  marginPct: number;
}

export function routeEconomics(project: ProjectView, creditPriceUsd: number): RouteEconomics[] {
  const base = Number(project.infraCostPerReqUsd);
  return (project.routeStats ?? []).map((r) => {
    const { factor, label } = computeProfile(r.route);
    const upstream = base * factor;
    const revenueUsd = r.creditsConsumed * creditPriceUsd;
    const infraCostUsd = r.allowedRequests * upstream + r.totalRequests * EDGE_COST_PER_EVAL_USD;
    let marginPct = 0;
    if (revenueUsd > 0) marginPct = ((revenueUsd - infraCostUsd) / revenueUsd) * 100;
    else if (infraCostUsd > 0) marginPct = -100;
    return {
      ...r,
      profile: label,
      blockedPct: r.totalRequests > 0 ? (r.blockedRequests / r.totalRequests) * 100 : 0,
      revenueUsd,
      infraCostUsd,
      savedSpendUsd: r.blockedRequests * upstream,
      marginPct,
    };
  });
}
