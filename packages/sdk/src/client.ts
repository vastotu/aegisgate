import { AEGIS_HEADERS, CheckRateLimitResponseSchema, type CheckRateLimitResponse } from '@aegisgate/shared';

export interface AegisGateConfig {
  apiKey: string;
  /** Default `http://localhost:4000`. */
  gatewayUrl?: string;
  /** Default 1500ms. */
  timeoutMs?: number;
  /** When the gateway is unreachable: allow (true, default) or block with 503 (false). */
  failOpen?: boolean;
  /** L1 WebSocket frame limit per client per second. Default 60. */
  l1FrameLimitPerSec?: number;
}

export interface CheckParams {
  route: string;
  method?: string;
  clientIp?: string;
  costOverride?: number;
}

export interface FrameCheckResult {
  allowed: boolean;
  currentFps: number;
  limitFps: number;
  reason?: string;
}

interface FrameState {
  windowStart: number;
  allowedCur: number;
  allowedPrev: number;
  receivedCur: number;
  receivedPrev: number;
  lastSeen: number;
  framesSinceReport: number;
  allowedSinceReport: number;
  route: string;
}

const FRAME_WINDOW_MS = 1_000;
const TELEMETRY_EVERY_N_FRAMES = 20;
const IDLE_CLIENT_MS = 30_000;
const SWEEP_EVERY_MS = 10_000;

const round = (value: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

const localRequestId = (): string => `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export class AegisGateClient {
  readonly apiKey: string;
  readonly gatewayUrl: string;
  readonly timeoutMs: number;
  readonly failOpen: boolean;
  readonly l1FrameLimitPerSec: number;

  private readonly frames = new Map<string, FrameState>();
  private lastSweep = 0;

  constructor(config: AegisGateConfig) {
    if (!config.apiKey) throw new Error('AegisGateClient: apiKey is required');
    this.apiKey = config.apiKey;
    this.gatewayUrl = (config.gatewayUrl ?? 'http://localhost:4000').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 1_500;
    this.failOpen = config.failOpen ?? true;
    this.l1FrameLimitPerSec = config.l1FrameLimitPerSec ?? 60;
  }

  /** Asks the gateway for a rate-limit + budget decision. Never throws. */
  async check(params: CheckParams): Promise<CheckRateLimitResponse> {
    const startedAt = performance.now();
    try {
      const res = await fetch(`${this.gatewayUrl}/v1/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AEGIS_HEADERS.API_KEY]: this.apiKey },
        body: JSON.stringify({
          route: params.route,
          method: (params.method ?? 'GET').toUpperCase(),
          clientIp: params.clientIp ?? '0.0.0.0',
          costOverride: params.costOverride,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const parsed = CheckRateLimitResponseSchema.safeParse(await res.json());
      // A 5xx decision means the gateway itself could not decide; treat it like an outage.
      if (parsed.success && parsed.data.statusCode < 500) return parsed.data;
    } catch {
      // Network error, timeout or non-JSON body: fall through to the local fallback.
    }
    return this.fallbackDecision(performance.now() - startedAt);
  }

  private fallbackDecision(elapsedMs: number): CheckRateLimitResponse {
    const base = {
      algorithm: 'none',
      limit: 0,
      remaining: 0,
      resetMs: 0,
      costCredits: 0,
      remainingBudgetCredits: 0,
      gatewayLatencyMs: round(elapsedMs),
      requestId: localRequestId(),
    };
    return this.failOpen
      ? { ...base, allowed: true, statusCode: 200, reason: 'FAIL_OPEN_FALLBACK' }
      : { ...base, allowed: false, statusCode: 503, reason: 'GATEWAY_UNAVAILABLE' };
  }

  /**
   * Synchronous L1 flood guard for WebSocket packets (e.g. HappyShark.io movement frames).
   * Uses an O(1) sliding 1-second counter per client and admits at most `l1FrameLimitPerSec`
   * frames/sec. Every 20 frames, the admitted frames are reported to the gateway asynchronously
   * as one `/v1/check` call with `costOverride` = admitted frames, so billing and telemetry stay in sync.
   */
  checkWebSocketFrame(clientId: string, route = '/ws/frame'): FrameCheckResult {
    const now = performance.now();
    this.sweepIdleClients(now);

    let s = this.frames.get(clientId);
    if (!s) {
      s = { windowStart: now, allowedCur: 0, allowedPrev: 0, receivedCur: 0, receivedPrev: 0, lastSeen: now, framesSinceReport: 0, allowedSinceReport: 0, route };
      this.frames.set(clientId, s);
    }

    const elapsed = now - s.windowStart;
    if (elapsed >= FRAME_WINDOW_MS) {
      const windows = Math.floor(elapsed / FRAME_WINDOW_MS);
      s.allowedPrev = windows === 1 ? s.allowedCur : 0;
      s.receivedPrev = windows === 1 ? s.receivedCur : 0;
      s.allowedCur = 0;
      s.receivedCur = 0;
      s.windowStart += windows * FRAME_WINDOW_MS;
    }

    const weight = 1 - (now - s.windowStart) / FRAME_WINDOW_MS;
    const allowed = s.allowedPrev * weight + s.allowedCur < this.l1FrameLimitPerSec;

    s.receivedCur++;
    s.framesSinceReport++;
    s.lastSeen = now;
    s.route = route;
    if (allowed) {
      s.allowedCur++;
      s.allowedSinceReport++;
    }

    const currentFps = Math.round(s.receivedPrev * weight + s.receivedCur);
    if (s.framesSinceReport >= TELEMETRY_EVERY_N_FRAMES) this.reportFrames(clientId, s);

    const result: FrameCheckResult = { allowed, currentFps, limitFps: this.l1FrameLimitPerSec };
    if (!allowed) result.reason = 'WS_FRAME_FLOOD';
    return result;
  }

  /** Flushes pending frame telemetry and forgets the client (call on socket close). */
  releaseWebSocketClient(clientId: string): void {
    const s = this.frames.get(clientId);
    if (!s) return;
    this.reportFrames(clientId, s);
    this.frames.delete(clientId);
  }

  private reportFrames(clientId: string, s: FrameState): void {
    const admitted = s.allowedSinceReport;
    s.framesSinceReport = 0;
    s.allowedSinceReport = 0;
    if (admitted === 0) return;
    void this.check({ route: s.route, method: 'WS', clientIp: clientId, costOverride: admitted });
  }

  private sweepIdleClients(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [clientId, s] of this.frames) {
      if (now - s.lastSeen > IDLE_CLIENT_MS) this.releaseWebSocketClient(clientId);
    }
  }
}

/**
 * Response headers to attach for a decision. The raw API key is never echoed.
 * Adds `retry-after` (seconds) on 429.
 */
export function toAegisHeaders(result: CheckRateLimitResponse): Record<string, string> {
  const headers: Record<string, string> = {
    [AEGIS_HEADERS.REQUEST_ID]: result.requestId,
    [AEGIS_HEADERS.ALGO]: result.algorithm,
    [AEGIS_HEADERS.LIMIT]: String(result.limit),
    [AEGIS_HEADERS.REMAINING]: String(result.remaining),
    [AEGIS_HEADERS.RESET]: String(result.resetMs),
    [AEGIS_HEADERS.LATENCY]: String(result.gatewayLatencyMs),
    [AEGIS_HEADERS.COST_CREDITS]: String(result.costCredits),
  };
  if (result.statusCode === 429) headers['retry-after'] = String(Math.max(1, Math.ceil(result.resetMs / 1000)));
  return headers;
}
