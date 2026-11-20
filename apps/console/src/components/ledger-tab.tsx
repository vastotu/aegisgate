'use client';

import { BookOpen, Landmark, Wallet, Zap } from 'lucide-react';
import { verifyLedgerChain } from '@aegisgate/shared';
import { useMemo, useState } from 'react';
import { fmtInt, shortHash, timeOf } from '@/lib/format';
import { gatewayClient } from '@/lib/gateway-client';
import type { LedgerEntryView, OverviewView, ProjectView } from '@/lib/types';
import { Badge, Button, Card, cn } from './ui';

interface TxGroup {
  transactionId: string;
  description: string;
  createdAt: string;
  entries: LedgerEntryView[];
  balanced: boolean;
}

function groupByTransaction(entries: LedgerEntryView[]): TxGroup[] {
  const groups = new Map<string, TxGroup>();
  for (const e of entries) {
    const g = groups.get(e.transactionId) ?? { transactionId: e.transactionId, description: e.description, createdAt: e.createdAt, entries: [], balanced: false };
    g.entries.push(e);
    groups.set(e.transactionId, g);
  }
  for (const g of groups.values()) {
    g.entries.sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'DEBIT' ? -1 : 1));
    const debit = g.entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + e.amountCredits, 0);
    const credit = g.entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + e.amountCredits, 0);
    g.balanced = debit === credit && debit > 0;
  }
  return [...groups.values()];
}

export function LedgerTab({ project, overview, onMutated }: { project: ProjectView; overview: OverviewView; onMutated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const entries = project.recentLedgerEntries;
  const groups = useMemo(() => groupByTransaction(entries), [entries]);
  // Same isomorphic SHA-256 as the gateway/Postgres writer, so live entries verify byte-for-byte.
  const verification = useMemo(() => verifyLedgerChain(entries), [entries]);

  const accountLabel = (e: LedgerEntryView): string => {
    if (e.accountId === project.walletAccountId) return `WALLET:${project.slug}`;
    return e.direction === 'DEBIT' ? 'SYSTEM:EQUITY_SEED' : 'PLATFORM:REVENUE';
  };

  const settle = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await gatewayClient.settleOrTopUp(project.slug);
      setMessage({
        tone: 'green',
        text: r.settledCredits > 0 ? `Settled ${fmtInt(r.settledCredits)} buffered credits` : `No pending usage, topped up wallet +${fmtInt(r.toppedUpCredits)} credits`,
      });
      onMutated();
    } catch (err) {
      setMessage({ tone: 'red', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const live = project.walletBalanceCredits - project.pendingUnsettledCredits;
  const budgetPct = project.monthlyBudgetCredits > 0 ? Math.min(100, Math.max(0, (live / project.monthlyBudgetCredits) * 100)) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card icon={<Wallet className="h-4 w-4" />} title={`WALLET:${project.slug}`} subtitle="Prepaid asset account (settled balance)">
          <div className="font-mono text-3xl font-semibold tabular-nums text-emerald-300">{fmtInt(project.walletBalanceCredits)}</div>
          <div className="mt-1 text-xs text-slate-500">
            live {fmtInt(live)} after {fmtInt(project.pendingUnsettledCredits)} unsettled edge charges
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400" style={{ width: `${budgetPct}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{budgetPct.toFixed(1)}% of {fmtInt(project.monthlyBudgetCredits)} monthly budget left</div>
        </Card>
        <Card icon={<Landmark className="h-4 w-4" />} title="PLATFORM:REVENUE" subtitle="Recognized revenue across all tenants">
          <div className="font-mono text-3xl font-semibold tabular-nums text-cyan-300">{fmtInt(overview.platform.revenueBalanceCredits)}</div>
          <div className="mt-1 text-xs text-slate-500">credits credited by batch usage settlements</div>
        </Card>
        <Card icon={<Zap className="h-4 w-4" />} title="Write-behind settlement" subtitle="Buffered usage → one balanced DEBIT/CREDIT pair per project">
          <Button variant="warning" className="w-full" disabled={busy} onClick={() => void settle()}>
            ⚡ Trigger Manual Batch Settlement / Top-Up Wallet
          </Button>
          <div className="mt-3 text-xs text-slate-500">
            Ring buffer {overview.worker.bufferSize}/{overview.worker.maxBufferSize} · {fmtInt(overview.worker.totalBatchesFlushed)} batches flushed
          </div>
          {message && (
            <Badge tone={message.tone} className="mt-2">
              {message.text}
            </Badge>
          )}
        </Card>
      </div>

      <Card
        icon={<BookOpen className="h-4 w-4" />}
        title="ACID double-entry journal"
        subtitle="Last 30 entries for this project, grouped by transactionId. DEBIT subtracts, CREDIT adds."
        actions={
          verification.verified ? (
            <Badge tone="green">✅ Hash Chain Verified (Immutable) · {verification.checked} entries</Badge>
          ) : (
            <Badge tone="red">⚠ Chain mismatch at entry {verification.checked + 1}</Badge>
          )
        }
      >
        <div className="space-y-3">
          {groups.length === 0 && <p className="text-sm text-slate-500">No ledger entries yet.</p>}
          {groups.map((g) => (
            <div key={g.transactionId} className="rounded-lg border border-slate-800 bg-slate-950/50">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-2">
                <div className="flex items-center gap-2 text-sm text-slate-200">
                  {g.description}
                  <Badge tone={g.balanced ? 'green' : 'amber'}>{g.balanced ? 'balanced' : 'partial window'}</Badge>
                </div>
                <div className="font-mono text-[11px] text-slate-500">
                  tx {g.transactionId.slice(0, 8)} · {timeOf(g.createdAt)}
                </div>
              </div>
              {g.entries.map((e) => (
                <div key={e.id} className="grid grid-cols-[72px_1fr_110px_120px] items-center gap-3 px-4 py-2 font-mono text-xs md:grid-cols-[72px_200px_110px_120px_1fr]">
                  <Badge tone={e.direction === 'DEBIT' ? 'red' : 'green'}>{e.direction}</Badge>
                  <span className="truncate text-slate-300">{accountLabel(e)}</span>
                  <span className={cn('text-right tabular-nums', e.direction === 'DEBIT' ? 'text-rose-300' : 'text-emerald-300')}>
                    {e.direction === 'DEBIT' ? '−' : '+'}
                    {fmtInt(e.amountCredits)}
                  </span>
                  <span className="text-right tabular-nums text-slate-400">bal {fmtInt(e.balanceAfter)}</span>
                  <span className="hidden truncate text-slate-500 md:block">
                    {shortHash(e.prevHash)}… → <span className="text-cyan-300">{shortHash(e.entryHash)}…</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
