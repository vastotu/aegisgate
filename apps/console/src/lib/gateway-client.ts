import {
  AEGIS_HEADERS,
  CheckRateLimitResponseSchema,
  type RateLimitAlgo,
  type SimulateBurstRequest,
  type SimulationResult,
} from '@aegisgate/shared';
import { LocalEngine } from './local-engine';
import type {
  CheckInput,
  CheckOutcome,
  ConnectionMode,
  CreatedProject,
  CreateProjectInput,
  OverviewView,
  RuleInput,
  RuleUpsertResult,
  SettlementResult,
  TrafficBatchRequest,
  TrafficBatchResult,
} from './types';

export const GATEWAY_URL = (process.env.NEXT_PUBLIC_GATEWAY_URL || 'https://aegisgate-gateway.onrender.com').replace(/\/+$/, '');
/** Must match the gateway's AEGIS_ADMIN_SECRET (dev default). Exposed to the browser: showcase use only. */
const ADMIN_SECRET = process.env.NEXT_PUBLIC_AEGIS_ADMIN_SECRET || 'ag_admin_master_secret_2026';
/** Generous enough for a warm Render instance after a short idle; cold starts fall back to the sandbox. */
const LIVE_TIMEOUT_MS = 4_000;
/** After a failed live call, stay in sandbox mode this long before probing the gateway again. */
const RETRY_LIVE_AFTER_MS = 5_000;
const RESPONSE_HEADERS = [...Object.values(AEGIS_HEADERS), 'retry-after'];

export const ALGORITHMS: RateLimitAlgo[] = ['fixed_window', 'sliding_window', 'token_bucket'];

class NetworkError extends Error {}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function apiError(res: Response): Promise<ApiError> {
  let reason = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { reason?: string; error?: string; issues?: { message?: string }[] };
    reason = body.reason ?? body.issues?.[0]?.message ?? body.error ?? reason;
  } catch {
    // non-JSON error body
  }
  return new ApiError(reason, res.status);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GatewayClient {
  readonly gatewayUrl = GATEWAY_URL;
  private mode: ConnectionMode = 'probing';
  private lastLiveFailure = 0;
  private engine: LocalEngine | null = null;
  private readonly listeners = new Set<(mode: ConnectionMode) => void>();

  getMode(): ConnectionMode {
    return this.mode;
  }

  subscribe(listener: (mode: ConnectionMode) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setMode(mode: ConnectionMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const listener of this.listeners) listener(mode);
  }

  private sandbox(): LocalEngine {
    this.engine ??= new LocalEngine();
    return this.engine;
  }

  private shouldTryLive(): boolean {
    return this.mode !== 'sandbox' || Date.now() - this.lastLiveFailure > RETRY_LIVE_AFTER_MS;
  }

  private async liveFetch(path: string, init: RequestInit = {}, admin = false): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (admin) headers.set('x-aegis-admin-secret', ADMIN_SECRET);
    try {
      const res = await fetch(`${GATEWAY_URL}${path}`, { ...init, headers, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
      this.setMode('live');
      return res;
    } catch (err) {
      this.lastLiveFailure = Date.now();
      this.setMode('sandbox');
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Live gateway first; on a network failure (or while the circuit is open) use the in-browser engine. */
  private async dual<T>(live: () => Promise<T>, local: (engine: LocalEngine) => Promise<T>): Promise<T> {
    if (this.shouldTryLive()) {
      try {
        return await live();
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
      }
    }
    return local(this.sandbox());
  }

  fetchOverview(): Promise<OverviewView> {
    return this.dual(
      async () => {
        const res = await this.liveFetch('/v1/admin/overview');
        if (!res.ok) throw await apiError(res);
        return (await res.json()) as OverviewView;
      },
      (engine) => engine.overview(),
    );
  }

  private async liveCheck(input: CheckInput): Promise<CheckOutcome> {
    const started = performance.now();
    const res = await this.liveFetch('/v1/check', {
      method: 'POST',
      headers: { [AEGIS_HEADERS.API_KEY]: input.apiKey },
      body: JSON.stringify({ route: input.route, method: input.method, clientIp: input.clientIp, costOverride: input.costOverride }),
    });
    const parsed = CheckRateLimitResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw await apiError(res);
    const headers: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { httpStatus: res.status, body: parsed.data, headers, rttMs: performance.now() - started };
  }

  /** Fires `count` checks (bounded concurrency or fixed pacing). The whole batch runs in one mode. */
  async fireLiveTrafficBatch(req: TrafficBatchRequest): Promise<TrafficBatchResult> {
    const started = performance.now();
    const inputFor = (i: number): CheckInput => ({ apiKey: req.apiKey, route: req.route, method: req.method, clientIp: req.clientIp(i) });

    let mode: 'live' | 'sandbox' = 'sandbox';
    const outcomes: CheckOutcome[] = [];
    if (this.shouldTryLive()) {
      try {
        outcomes.push(await this.liveCheck(inputFor(0)));
        mode = 'live';
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
      }
    }
    const engine = mode === 'sandbox' ? this.sandbox() : null;
    const fire = (i: number): Promise<CheckOutcome> => (engine ? engine.check(inputFor(i)) : this.liveCheck(inputFor(i)));

    const start = outcomes.length;
    if (req.paceMs !== undefined) {
      const paced = Array.from({ length: req.count - start }, (_, k) => delay(k * req.paceMs!).then(() => fire(start + k)));
      outcomes.push(...(await Promise.all(paced)));
    } else {
      let next = start;
      const worker = async (): Promise<void> => {
        while (next < req.count) outcomes.push(await fire(next++));
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(req.concurrency, req.count)) }, worker));
    }
    return { outcomes, mode, elapsedMs: performance.now() - started };
  }

  async runBurstSimulation(base: Omit<SimulateBurstRequest, 'algorithm'>): Promise<Record<RateLimitAlgo, SimulationResult>> {
    const entries = await Promise.all(
      ALGORITHMS.map(async (algorithm) => {
        const req: SimulateBurstRequest = { ...base, algorithm };
        const result = await this.dual(
          async () => {
            const res = await this.liveFetch('/v1/simulate-burst', { method: 'POST', body: JSON.stringify(req) });
            if (!res.ok) throw await apiError(res);
            return (await res.json()) as SimulationResult;
          },
          async (engine) => engine.simulate(req),
        );
        return [algorithm, result] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<RateLimitAlgo, SimulationResult>;
  }

  createProject(input: CreateProjectInput): Promise<CreatedProject> {
    return this.dual(
      async () => {
        const res = await this.liveFetch('/v1/admin/projects', { method: 'POST', body: JSON.stringify(input) }, true);
        if (!res.ok) throw await apiError(res);
        return (await res.json()) as CreatedProject;
      },
      (engine) => engine.createProject(input),
    );
  }

  createRule(input: RuleInput): Promise<RuleUpsertResult> {
    return this.dual(
      async () => {
        const res = await this.liveFetch('/v1/admin/rules', { method: 'POST', body: JSON.stringify(input) }, true);
        if (!res.ok) throw await apiError(res);
        return (await res.json()) as RuleUpsertResult;
      },
      (engine) => engine.upsertRule(input),
    );
  }

  /** Deletes a custom project (showcase tenants are rejected by both the gateway and the sandbox). */
  deleteProject(projectId: string): Promise<void> {
    return this.dual(
      async () => {
        const res = await this.liveFetch(`/v1/admin/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }, true);
        if (!res.ok) throw await apiError(res);
      },
      (engine) => engine.deleteProject(projectId),
    );
  }

  deleteRule(projectId: string, ruleId: string): Promise<void> {
    return this.dual(
      async () => {
        const res = await this.liveFetch(`/v1/admin/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }, true);
        if (!res.ok) throw await apiError(res);
      },
      (engine) => engine.deleteRule(projectId, ruleId),
    );
  }

  /** Settles buffered usage into the ledger; if nothing was pending, tops up the wallet instead. */
  settleOrTopUp(projectSlug: string, topUpCredits = 10_000): Promise<SettlementResult> {
    return this.dual(
      async () => {
        const flush = await this.liveFetch('/v1/admin/flush', { method: 'POST', body: '{}' }, true);
        if (!flush.ok) throw await apiError(flush);
        const { settledCredits } = (await flush.json()) as { settledCredits: number };
        if (settledCredits > 0) return { settledCredits, toppedUpCredits: 0 };
        const topUp = await this.liveFetch(
          '/v1/admin/wallet/topup',
          { method: 'POST', body: JSON.stringify({ projectSlug, amountCredits: topUpCredits }) },
          true,
        );
        if (!topUp.ok) throw await apiError(topUp);
        return { settledCredits: 0, toppedUpCredits: topUpCredits };
      },
      async (engine) => {
        const { settledCredits } = await engine.flush();
        if (settledCredits > 0) return { settledCredits, toppedUpCredits: 0 };
        await engine.topUp(projectSlug, topUpCredits);
        return { settledCredits: 0, toppedUpCredits: topUpCredits };
      },
    );
  }
}

export const gatewayClient = new GatewayClient();
