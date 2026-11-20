import {
  apiUsageLogs,
  db,
  ledgerAccounts,
  projects,
  recordDoubleEntryTransaction,
  type NewApiUsageLog,
} from '@aegisgate/db';
import type { UsageLogEvent } from '@aegisgate/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { pgErrorCode } from './db-errors';
import { isOfflineProject, settleOfflineUsage } from './showcase-fallback';

export const MAX_BATCH_SIZE = 500;
export const FLUSH_INTERVAL_MS = 5_000;
const RECENT_EVENTS_CAPACITY = 200;
/** Hard cap on buffered events while Postgres is unreachable (oldest are dropped beyond this). */
const MAX_PENDING_LOGS = 50_000;
const PLATFORM_REVENUE_CODE = 'PLATFORM:REVENUE';

const pendingLogs: UsageLogEvent[] = [];
let totalBatchesFlushed = 0;

// Bounded ring buffer of the most recent events for live polling.
const recentRing: UsageLogEvent[] = [];
let ringNext = 0;

/** Credits charged at the edge but not yet posted to the ledger, per project. */
const unsettledCredits = new Map<string, number>();
/** Ledger postings that failed and will be retried on the next flush. */
const pendingSettlements = new Map<string, { credits: number; count: number }>();

let flushing: Promise<FlushResult> | null = null;
let sizeTriggerBlockedUntil = 0;
let flushTimer: NodeJS.Timeout | null = null;

let revenueAccountId: string | null = null;
const walletAccountIds = new Map<string, string>();

export interface FlushResult {
  flushedEvents: number;
  settledProjects: number;
  settledCredits: number;
  pendingSettlements: number;
  error?: string;
}

export interface WorkerMetrics {
  bufferSize: number;
  maxBufferSize: number;
  totalBatchesFlushed: number;
  recentLiveEvents: UsageLogEvent[];
}

const isBillable = (e: UsageLogEvent): boolean => e.statusCode < 400 && e.costCredits > 0;

function addUnsettled(projectId: string, delta: number): void {
  const next = (unsettledCredits.get(projectId) ?? 0) + delta;
  if (next > 0) unsettledCredits.set(projectId, next);
  else unsettledCredits.delete(projectId);
}

const warnedAt = new Map<string, number>();
function warnThrottled(topic: string, message: string): void {
  const now = Date.now();
  if (now - (warnedAt.get(topic) ?? 0) < 30_000) return;
  warnedAt.set(topic, now);
  console.warn(`[batch-worker] ${message}`);
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function pushRecent(event: UsageLogEvent): void {
  if (recentRing.length < RECENT_EVENTS_CAPACITY) recentRing.push(event);
  else recentRing[ringNext] = event;
  ringNext = (ringNext + 1) % RECENT_EVENTS_CAPACITY;
}

/** Most recent events, newest first. */
function getRecentLiveEvents(): UsageLogEvent[] {
  const n = recentRing.length;
  const out: UsageLogEvent[] = [];
  for (let i = 0; i < n; i++) out.push(recentRing[(ringNext - 1 - i + n) % n]!);
  return out;
}

export function enqueueUsageLog(event: UsageLogEvent): void {
  pendingLogs.push(event);
  pushRecent(event);
  if (isBillable(event)) addUnsettled(event.projectId, event.costCredits);

  if (pendingLogs.length > MAX_PENDING_LOGS) {
    const dropped = pendingLogs.splice(0, pendingLogs.length - MAX_PENDING_LOGS);
    for (const e of dropped) if (isBillable(e)) addUnsettled(e.projectId, -e.costCredits);
    warnThrottled('overflow', `Buffer overflow: dropped ${dropped.length} oldest events`);
  }

  if (pendingLogs.length >= MAX_BATCH_SIZE && Date.now() >= sizeTriggerBlockedUntil) {
    void flushBatch();
  }
}

export function getUnsettledCredits(projectId: string): number {
  return unsettledCredits.get(projectId) ?? 0;
}

export function getWorkerMetrics(): WorkerMetrics {
  return {
    bufferSize: pendingLogs.length,
    maxBufferSize: MAX_BATCH_SIZE,
    totalBatchesFlushed,
    recentLiveEvents: getRecentLiveEvents(),
  };
}

function toRow(e: UsageLogEvent): NewApiUsageLog {
  return {
    requestId: e.requestId.slice(0, 64),
    projectId: e.projectId,
    route: e.route.slice(0, 255),
    method: e.method.slice(0, 16),
    statusCode: e.statusCode,
    latencyMs: Math.min(Math.max(e.latencyMs, 0), 999_999.99).toFixed(2),
    costCredits: e.costCredits,
    clientIp: e.clientIp.slice(0, 64),
    blockedReason: e.blockedReason ? e.blockedReason.slice(0, 64) : null,
    createdAt: new Date(e.timestamp),
  };
}

/** Inserts usage rows. On FK violations (project deleted mid-flight), drops orphaned events and retries once. */
async function insertUsageRows(batch: UsageLogEvent[]): Promise<UsageLogEvent[]> {
  try {
    await db.insert(apiUsageLogs).values(batch.map(toRow));
    return batch;
  } catch (err) {
    if (pgErrorCode(err) !== '23503') throw err;

    const ids = [...new Set(batch.map((e) => e.projectId))];
    const existing = new Set(
      (await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, ids))).map((r) => r.id),
    );
    const kept = batch.filter((e) => existing.has(e.projectId));
    for (const id of ids) {
      if (!existing.has(id)) {
        unsettledCredits.delete(id);
        walletAccountIds.delete(id);
      }
    }
    warnThrottled('orphans', `Dropped ${batch.length - kept.length} events for deleted projects`);
    if (kept.length > 0) await db.insert(apiUsageLogs).values(kept.map(toRow));
    return kept;
  }
}

async function resolveSettlementAccounts(projectId: string): Promise<{ walletId: string; revenueId: string } | null> {
  if (!revenueAccountId) {
    const [revenue] = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.accountCode, PLATFORM_REVENUE_CODE))
      .limit(1);
    if (!revenue) throw new Error(`${PLATFORM_REVENUE_CODE} ledger account missing`);
    revenueAccountId = revenue.id;
  }

  let walletId = walletAccountIds.get(projectId);
  if (!walletId) {
    const [wallet] = await db
      .select({ id: ledgerAccounts.id })
      .from(projects)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.accountCode, sql<string>`'WALLET:' || ${projects.slug}`))
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!wallet) return null;
    walletId = wallet.id;
    walletAccountIds.set(projectId, walletId);
  }

  return { walletId, revenueId: revenueAccountId };
}

async function doFlush(): Promise<FlushResult> {
  const spliced = pendingLogs.splice(0, MAX_BATCH_SIZE);
  const result: FlushResult = { flushedEvents: 0, settledProjects: 0, settledCredits: 0, pendingSettlements: 0 };

  // Offline showcase tenants (resolved while Postgres was down) settle against the in-memory ledger.
  const offline = spliced.filter((e) => isOfflineProject(e.projectId));
  const batch = offline.length > 0 ? spliced.filter((e) => !isOfflineProject(e.projectId)) : spliced;
  if (offline.length > 0) {
    for (const [projectId, credits] of settleOfflineUsage(offline)) {
      addUnsettled(projectId, -credits);
      result.settledProjects++;
      result.settledCredits += credits;
    }
    result.flushedEvents += offline.length;
    if (batch.length === 0) totalBatchesFlushed++;
  }

  // Step A: bulk insert telemetry.
  let inserted: UsageLogEvent[] = [];
  if (batch.length > 0) {
    try {
      inserted = await insertUsageRows(batch);
      totalBatchesFlushed++;
      result.flushedEvents += inserted.length;
    } catch (err) {
      pendingLogs.unshift(...batch);
      sizeTriggerBlockedUntil = Date.now() + FLUSH_INTERVAL_MS;
      warnThrottled('insert', `Postgres unavailable, ${pendingLogs.length} events buffered (${errorMessage(err)})`);
      return { ...result, pendingSettlements: pendingSettlements.size, error: errorMessage(err) };
    }
  }

  // Step B: aggregate billable usage per project (plus any previously failed settlements).
  const groups = new Map(pendingSettlements);
  pendingSettlements.clear();
  for (const e of inserted) {
    if (!isBillable(e)) continue;
    const g = groups.get(e.projectId) ?? { credits: 0, count: 0 };
    g.credits += e.costCredits;
    g.count += 1;
    groups.set(e.projectId, g);
  }

  // Step C: post one balanced double-entry transaction per project.
  // DEBIT WALLET:<slug> (balance decreases), CREDIT PLATFORM:REVENUE (balance increases).
  for (const [projectId, { credits, count }] of groups) {
    if (credits <= 0) continue;
    try {
      const accounts = await resolveSettlementAccounts(projectId);
      if (!accounts) {
        unsettledCredits.delete(projectId);
        warnThrottled(`wallet:${projectId}`, `No wallet for project ${projectId}; dropping ${credits} credits`);
        continue;
      }
      await recordDoubleEntryTransaction(db, {
        projectId,
        debitAccountId: accounts.walletId,
        creditAccountId: accounts.revenueId,
        amountCredits: credits,
        description: `Batch API usage settlement (${count} requests)`,
      });
      addUnsettled(projectId, -credits);
      result.settledProjects++;
      result.settledCredits += credits;
    } catch (err) {
      const prev = pendingSettlements.get(projectId) ?? { credits: 0, count: 0 };
      pendingSettlements.set(projectId, { credits: prev.credits + credits, count: prev.count + count });
      revenueAccountId = null;
      walletAccountIds.delete(projectId);
      warnThrottled('ledger', `Ledger settlement deferred for ${projectId} (${errorMessage(err)})`);
      result.error = errorMessage(err);
    }
  }

  result.pendingSettlements = pendingSettlements.size;
  return result;
}

/** Flushes up to MAX_BATCH_SIZE buffered events. Concurrent callers share the in-flight flush. */
export function flushBatch(): Promise<FlushResult> {
  if (flushing) return flushing;
  flushing = doFlush()
    .catch((err): FlushResult => {
      warnThrottled('flush', `Flush failed (${errorMessage(err)})`);
      return { flushedEvents: 0, settledProjects: 0, settledCredits: 0, pendingSettlements: pendingSettlements.size, error: errorMessage(err) };
    })
    .finally(() => {
      flushing = null;
      // Drain backlog promptly when traffic outpaces the interval.
      if (pendingLogs.length >= MAX_BATCH_SIZE && Date.now() >= sizeTriggerBlockedUntil) {
        setImmediate(() => void flushBatch());
      }
    });
  return flushing;
}

export function startBatchWorker(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flushBatch(), FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

/** Stops the timer and attempts a final flush. */
export async function stopBatchWorker(): Promise<FlushResult> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  return flushBatch();
}
