import { computeProfile, EDGE_COST_PER_EVAL_USD } from './finops';
import type { ProjectView } from './types';

export const PLATFORM_FIXED_MONTHLY_USD = 1_800; // gateway nodes + managed Postgres + Redis
export const BUDGET_UTILIZATION = 0.6; // share of the monthly credit budget a typical tenant consumes

export type PricingModel = 'payg' | 'tiered' | 'flat_overage';

export const PRICING_MODELS: { id: PricingModel; label: string; detail: string }[] = [
  { id: 'payg', label: 'Pay-As-You-Go', detail: 'Every credit billed at the unit price' },
  { id: 'tiered', label: 'Tiered Volume Discount', detail: '0–100k full price · 100k–500k −20% · 500k+ −40%' },
  { id: 'flat_overage', label: 'Flat Base + Overage', detail: '$49/mo includes 50k credits, overage at unit price' },
];

function revenuePerTenant(model: PricingModel, credits: number, price: number): number {
  switch (model) {
    case 'payg':
      return credits * price;
    case 'tiered': {
      const t1 = Math.min(credits, 100_000);
      const t2 = Math.min(Math.max(credits - 100_000, 0), 400_000);
      const t3 = Math.max(credits - 500_000, 0);
      return t1 * price + t2 * price * 0.8 + t3 * price * 0.6;
    }
    case 'flat_overage':
      return 49 + Math.max(credits - 50_000, 0) * price;
  }
}

export interface PricingProjection {
  creditsPerTenant: number;
  revenuePerTenant: number;
  mrr: number;
  arr: number;
  cogs: number;
  platformFixed: number;
  ddosSavings: number;
  netProfit: number;
  netMarginPct: number;
}

/** Projects monthly economics for `tenants` customers shaped like the selected project's observed traffic. */
export function projectPricing(
  project: ProjectView,
  input: { creditPriceUsd: number; model: PricingModel; tenants: number },
): PricingProjection {
  const base = Number(project.infraCostPerReqUsd);
  let allowed = 0;
  let blocked = 0;
  let credits = 0;
  let upstreamCost = 0;
  for (const r of project.routeStats ?? []) {
    allowed += r.allowedRequests;
    blocked += r.blockedRequests;
    credits += r.creditsConsumed;
    upstreamCost += r.allowedRequests * base * computeProfile(r.route).factor;
  }

  const creditsPerAllowedReq = allowed > 0 && credits > 0 ? credits / allowed : 1;
  const blockedPerAllowed = allowed > 0 ? blocked / allowed : 0.2;
  const upstreamPerAllowed = allowed > 0 ? upstreamCost / allowed : base;

  const creditsPerTenant = project.monthlyBudgetCredits * BUDGET_UTILIZATION;
  const allowedPerTenant = creditsPerTenant / creditsPerAllowedReq;
  const blockedPerTenant = allowedPerTenant * blockedPerAllowed;

  const perTenantRevenue = revenuePerTenant(input.model, creditsPerTenant, input.creditPriceUsd);
  const mrr = perTenantRevenue * input.tenants;
  const cogs =
    input.tenants * (allowedPerTenant * upstreamPerAllowed + (allowedPerTenant + blockedPerTenant) * EDGE_COST_PER_EVAL_USD);
  const ddosSavings = input.tenants * blockedPerTenant * upstreamPerAllowed;
  const netProfit = mrr - cogs - PLATFORM_FIXED_MONTHLY_USD;

  return {
    creditsPerTenant,
    revenuePerTenant: perTenantRevenue,
    mrr,
    arr: mrr * 12,
    cogs,
    platformFixed: PLATFORM_FIXED_MONTHLY_USD,
    ddosSavings,
    netProfit,
    netMarginPct: mrr > 0 ? (netProfit / mrr) * 100 : 0,
  };
}
