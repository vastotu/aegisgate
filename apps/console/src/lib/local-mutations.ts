import { SHOWCASE_TENANTS, type RateLimitAlgo } from '@aegisgate/shared';
import { createRng, DEFAULT_RULE_SPEC, randomHex, ROUTE_PATTERN, sampleRouteFor, SLUG_PATTERN, uuid } from './engine-utils';
import { emptyUsage, MAX_BATCH_SIZE, recordUsage, type LocalTenant, type SandboxState } from './local-state';
import type { CreatedProject, CreateProjectInput, ProjectCore, RuleInput, RuleUpsertResult, RuleView } from './types';

const CREDIT_UNIT_PRICE_USD = '0.001000';
const INFRA_COST_PER_REQ_USD = '0.000150';
const HISTORY_ROWS_PER_TENANT = 150;

interface RuleSpecLike {
  routePattern: string;
  httpMethod?: string;
  algorithm: string;
  limitCount: number;
  windowSec: number;
  burstCapacity: number;
  costWeightCredits: number;
  priority: number;
}

function addTenant(
  state: SandboxState,
  core: Omit<ProjectCore, 'id' | 'createdAt' | 'creditUnitPriceUsd' | 'infraCostPerReqUsd'>,
  rawKey: string,
  ruleSpecs: readonly RuleSpecLike[],
): LocalTenant {
  const createdAt = new Date().toISOString();
  const project: ProjectCore = {
    ...core,
    id: uuid(),
    creditUnitPriceUsd: CREDIT_UNIT_PRICE_USD,
    infraCostPerReqUsd: INFRA_COST_PER_REQ_USD,
    createdAt,
  };
  const rules: RuleView[] = ruleSpecs
    .map((r) => ({ ...r, httpMethod: r.httpMethod ?? 'ALL', id: uuid(), projectId: project.id, createdAt }))
    .sort((a, b) => b.priority - a.priority);
  const tenant: LocalTenant = {
    project,
    apiKey: { id: uuid(), name: core.isShowcaseTenant ? 'Showcase Demo Key' : 'Default Key', keyPrefix: `${rawKey.slice(0, 16)}...`, isActive: true, createdAt },
    rawKey,
    rules,
    wallet: { id: uuid(), code: `WALLET:${core.slug}`, balance: 0 },
    usage: emptyUsage(),
    unsettled: 0,
  };
  state.byId.set(project.id, tenant);
  state.byKey.set(rawKey, tenant);
  return tenant;
}

/** Seeds the 3 showcase tenants: funded wallets (DEBIT SYSTEM:EQUITY_SEED / CREDIT WALLET) + 24h synthetic history. */
export async function bootstrapState(state: SandboxState): Promise<void> {
  const rng = createRng(20260101);
  for (const spec of SHOWCASE_TENANTS) {
    const tenant = addTenant(
      state,
      {
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
        upstreamUrl: spec.upstreamUrl,
        monthlyBudgetCredits: spec.monthlyBudgetCredits,
        isShowcaseTenant: true,
      },
      spec.demoApiKey,
      spec.rules,
    );
    await state.ledger.post(tenant.project.id, state.equity, tenant.wallet, spec.monthlyBudgetCredits, `Initial prepaid credit grant for ${spec.slug}`);
    for (let i = 0; i < HISTORY_ROWS_PER_TENANT; i++) {
      const rule = tenant.rules[Math.floor(rng() * tenant.rules.length)]!;
      const blocked = rng() < 0.18;
      const latency = Math.round((1.1 + rng() * 3.7) * 100) / 100;
      recordUsage(tenant.usage, sampleRouteFor(rule.routePattern), blocked ? 429 : 200, latency, blocked ? 0 : rule.costWeightCredits);
    }
  }
}

/** Write-behind flush: aggregate usage, then one DEBIT WALLET / CREDIT PLATFORM:REVENUE pair per project. */
export async function flushState(state: SandboxState): Promise<{ flushedEvents: number; settledCredits: number }> {
  const batch = state.pending.splice(0, MAX_BATCH_SIZE);
  state.lastFlushAt = Date.now();
  if (batch.length === 0) return { flushedEvents: 0, settledCredits: 0 };
  state.totalBatchesFlushed++;

  const groups = new Map<string, { credits: number; count: number }>();
  for (const e of batch) {
    const tenant = state.byId.get(e.projectId);
    if (!tenant) continue;
    recordUsage(tenant.usage, e.route, e.statusCode, e.latencyMs, e.costCredits);
    if (e.statusCode < 400 && e.costCredits > 0) {
      const g = groups.get(e.projectId) ?? { credits: 0, count: 0 };
      g.credits += e.costCredits;
      g.count += 1;
      groups.set(e.projectId, g);
    }
  }

  let settledCredits = 0;
  for (const [projectId, { credits, count }] of groups) {
    const tenant = state.byId.get(projectId)!;
    await state.ledger.post(projectId, tenant.wallet, state.revenue, credits, `Batch API usage settlement (${count} requests)`);
    tenant.unsettled -= credits;
    settledCredits += credits;
  }
  return { flushedEvents: batch.length, settledCredits };
}

const findBySlug = (state: SandboxState, slug: string): LocalTenant | undefined =>
  [...state.byId.values()].find((t) => t.project.slug === slug);

export async function createProjectInState(state: SandboxState, input: CreateProjectInput): Promise<CreatedProject> {
  if (!SLUG_PATTERN.test(input.slug)) throw new Error('slug must be 2-48 chars of a-z, 0-9 or -');
  if (!/^https?:\/\//i.test(input.upstreamUrl)) throw new Error('upstreamUrl must be an http(s) URL');
  if (!Number.isInteger(input.monthlyBudgetCredits) || input.monthlyBudgetCredits <= 0) {
    throw new Error('monthlyBudgetCredits must be a positive integer');
  }
  if (findBySlug(state, input.slug)) throw new Error(`Project slug '${input.slug}' already exists`);

  const rawKey = `ag_live_${input.slug}_${randomHex(16)}`;
  const tenant = addTenant(
    state,
    {
      name: input.name.trim(),
      slug: input.slug,
      description: input.description ?? null,
      upstreamUrl: input.upstreamUrl,
      monthlyBudgetCredits: input.monthlyBudgetCredits,
      isShowcaseTenant: false,
    },
    rawKey,
    [DEFAULT_RULE_SPEC],
  );
  await state.ledger.post(tenant.project.id, state.equity, tenant.wallet, input.monthlyBudgetCredits, `Initial prepaid credit grant for ${input.slug}`);
  return {
    project: { id: tenant.project.id, name: tenant.project.name, slug: tenant.project.slug },
    apiKey: rawKey,
    keyPrefix: tenant.apiKey.keyPrefix,
    initialCredits: input.monthlyBudgetCredits,
  };
}

export function upsertRuleInState(state: SandboxState, input: RuleInput): RuleUpsertResult {
  const tenant = findBySlug(state, input.projectSlug);
  if (!tenant) throw new Error('Project not found');
  if (!ROUTE_PATTERN.test(input.routePattern)) {
    throw new Error("routePattern must be '*', an exact path, or a prefix ending in '*'");
  }
  const httpMethod = input.httpMethod.toUpperCase();
  const values = {
    routePattern: input.routePattern,
    httpMethod,
    algorithm: input.algorithm as RateLimitAlgo,
    limitCount: input.limitCount,
    windowSec: input.windowSec,
    burstCapacity: input.burstCapacity,
    costWeightCredits: input.costWeightCredits,
    priority: input.priority,
  };
  const existing = tenant.rules.find((r) => r.routePattern === values.routePattern && r.httpMethod === httpMethod);
  let rule: RuleView;
  let action: 'created' | 'updated';
  if (existing) {
    Object.assign(existing, values);
    rule = existing;
    action = 'updated';
  } else {
    rule = { ...values, id: uuid(), projectId: tenant.project.id, createdAt: new Date().toISOString() };
    tenant.rules.push(rule);
    action = 'created';
  }
  tenant.rules.sort((a, b) => b.priority - a.priority);
  return { action, rule: { ...rule } };
}

export const SHOWCASE_DELETE_ERROR = 'Builtin showcase tenants cannot be deleted, only custom projects can be removed.';
export const LAST_WILDCARD_ERROR = "The last '*' fallback rule cannot be deleted: every project keeps a baseline rule.";

/** Same semantics as DELETE /v1/admin/projects/:id: cascade, then reverse the journal's effect on platform accounts. */
export function deleteProjectInState(state: SandboxState, projectId: string): void {
  const tenant = state.byId.get(projectId);
  if (!tenant) throw new Error('Project not found');
  if (tenant.project.isShowcaseTenant) throw new Error(SHOWCASE_DELETE_ERROR);
  for (const e of state.ledger.removeProject(projectId)) {
    const account = e.accountId === state.equity.id ? state.equity : e.accountId === state.revenue.id ? state.revenue : null;
    if (account) account.balance -= e.direction === 'CREDIT' ? e.amountCredits : -e.amountCredits;
  }
  state.byId.delete(projectId);
  state.byKey.delete(tenant.rawKey);
  state.pending = state.pending.filter((e) => e.projectId !== projectId);
  state.recent = state.recent.filter((e) => e.projectId !== projectId);
}

export function deleteRuleInState(state: SandboxState, projectId: string, ruleId: string): void {
  const tenant = state.byId.get(projectId);
  if (!tenant) throw new Error('Project not found');
  const index = tenant.rules.findIndex((r) => r.id === ruleId);
  if (index < 0) throw new Error('Rule not found');
  if (tenant.rules[index]!.routePattern === '*' && tenant.rules.filter((r) => r.routePattern === '*').length === 1) {
    throw new Error(LAST_WILDCARD_ERROR);
  }
  tenant.rules.splice(index, 1);
}

export async function topUpInState(state: SandboxState, slug: string, amountCredits: number): Promise<number> {
  const tenant = findBySlug(state, slug);
  if (!tenant) throw new Error('Project not found');
  await state.ledger.post(tenant.project.id, state.equity, tenant.wallet, amountCredits, `Wallet top-up (+${amountCredits} credits)`);
  return tenant.wallet.balance;
}
