'use client';

import { Coins, Gauge, Layers, Radio, ShieldCheck, ShieldX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { fmtInt, fmtMs, fmtPct, percentile } from '@/lib/format';
import { gatewayClient } from '@/lib/gateway-client';
import { primaryRoute } from '@/lib/routes';
import type { CheckOutcome, ProjectView, TrafficBatchRequest, WorkerView } from '@/lib/types';
import { BurstVisualizer } from './burst-visualizer';
import { GamePreview, type ShieldState } from './game-preview';
import { Badge, Button, Card, Kpi, cn } from './ui';

interface SessionStats {
  allowed: number;
  blocked: number;
  latencies: number[];
  credits: number;
}

type ShotKind = 'normal' | 'ddos' | 'speedhack';
const EMPTY_STATS: SessionStats = { allowed: 0, blocked: 0, latencies: [], credits: 0 };

function statusTone(code: number): string {
  if (code < 400) return 'bg-emerald-400';
  if (code === 429) return 'bg-rose-500';
  if (code === 402) return 'bg-violet-500';
  return 'bg-amber-400';
}

export function TrafficLab({
  project,
  apiKey,
  worker,
  onTraffic,
}: {
  project: ProjectView;
  apiKey: string | null;
  worker?: WorkerView;
  onTraffic: () => void;
}) {
  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);
  const [last, setLast] = useState<CheckOutcome | null>(null);
  const [strip, setStrip] = useState<number[]>([]);
  const [shield, setShield] = useState<ShieldState>({ kind: 'idle' });
  const [busy, setBusy] = useState<ShotKind | null>(null);
  const [batchMode, setBatchMode] = useState<'live' | 'sandbox' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStats(EMPTY_STATS);
    setLast(null);
    setStrip([]);
    setShield({ kind: 'idle' });
  }, [project.slug]);

  const route = useMemo(() => primaryRoute(project), [project]);
  const hasWsRule = project.rateLimitRules.some((r) => r.routePattern === '/ws/frame');

  const fire = async (kind: ShotKind) => {
    if (!apiKey) return;
    setBusy(kind);
    setError(null);
    const req: TrafficBatchRequest =
      kind === 'normal'
        ? { apiKey, route, method: 'POST', count: 25, concurrency: 5, clientIp: (i) => `198.51.100.${10 + i}` }
        : kind === 'ddos'
          ? { apiKey, route, method: 'POST', count: 80, concurrency: 15, clientIp: () => '203.0.113.66' }
          : { apiKey, route: '/ws/frame', method: 'WS', count: 120, concurrency: 120, clientIp: () => '192.0.2.120', paceMs: 1000 / 120 };
    try {
      const { outcomes, mode } = await gatewayClient.fireLiveTrafficBatch(req);
      const allowed = outcomes.filter((o) => o.body.allowed).length;
      const blocked = outcomes.length - allowed;
      setStats((s) => ({
        allowed: s.allowed + allowed,
        blocked: s.blocked + blocked,
        latencies: [...s.latencies, ...outcomes.map((o) => o.body.gatewayLatencyMs)].slice(-2_000),
        credits: s.credits + outcomes.reduce((sum, o) => sum + o.body.costCredits, 0),
      }));
      setLast(outcomes[outcomes.length - 1] ?? null);
      setStrip(outcomes.map((o) => o.httpStatus));
      setBatchMode(mode);
      setShield(
        kind === 'normal'
          ? { kind: 'normal', allowed }
          : kind === 'ddos'
            ? { kind: 'ddos', allowed, blocked }
            : { kind: 'speedhack', sent: outcomes.length, admitted: allowed, dropped: blocked },
      );
      onTraffic();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const fill = worker && worker.maxBufferSize > 0 ? (worker.bufferSize / worker.maxBufferSize) * 100 : 0;
  const total = stats.allowed + stats.blocked;

  return (
    <div className="space-y-6">
      <Card
        icon={<Radio className="h-4 w-4" />}
        title="Interactive Traffic Shooter"
        subtitle={
          <>
            Target <span className="font-mono text-slate-300">{project.slug}</span> · route{' '}
            <span className="font-mono text-slate-300">{route}</span>
            {batchMode && <span className="ml-2 text-slate-500">(last batch via {batchMode === 'live' ? 'live gateway' : 'in-browser engine'})</span>}
          </>
        }
      >
        {!apiKey && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            No raw API key known for this project in this session. Create it via “New Project” to fire traffic.
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" disabled={!apiKey || busy !== null} onClick={() => void fire('normal')}>
            🚀 Fire 25 Normal Requests ({route})
          </Button>
          <Button variant="danger" disabled={!apiKey || busy !== null} onClick={() => void fire('ddos')}>
            💥 Launch 80-Req DDoS Flood Attack (Test Rate Limiter)
          </Button>
          <Button
            variant="warning"
            disabled={!apiKey || busy !== null || !hasWsRule}
            title={hasWsRule ? undefined : 'Needs a /ws/frame rule (HappyShark.io)'}
            onClick={() => void fire('speedhack')}
          >
            🦈 Simulate HappyShark WebSocket Speed-Hack (120 pkt/s &gt; 60 FPS cap)
          </Button>
        </div>
        {busy && <div className="mt-3 animate-pulse text-xs text-cyan-300">Firing {busy} traffic…</div>}
        {error && <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Kpi label="Allowed (200 OK)" value={fmtInt(stats.allowed)} tone="green" icon={<ShieldCheck className="h-4 w-4" />} hint={total ? fmtPct((stats.allowed / total) * 100) : 'session'} />
          <Kpi label="Blocked (429/402)" value={fmtInt(stats.blocked)} tone="red" icon={<ShieldX className="h-4 w-4" />} hint={total ? fmtPct((stats.blocked / total) * 100) : 'session'} />
          <Kpi label="Gateway P95 Latency" value={stats.latencies.length ? fmtMs(percentile(stats.latencies, 95)) : '—'} tone="cyan" icon={<Gauge className="h-4 w-4" />} hint="server-side decision time" />
          <Kpi label="Credits Deducted" value={fmtInt(stats.credits)} tone="amber" icon={<Coins className="h-4 w-4" />} hint="optimistic, settled by write-behind" />
          <Kpi
            label="Ring Buffer Fill"
            value={worker ? `${worker.bufferSize}/${worker.maxBufferSize}` : '—'}
            tone="violet"
            icon={<Layers className="h-4 w-4" />}
            hint={
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-800">
                <span className="block h-full rounded-full bg-violet-400 transition-all" style={{ width: `${Math.min(100, fill)}%` }} />
              </span>
            }
          />
        </div>

        {strip.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-500">Last batch decisions ({strip.length})</div>
            <div className="flex flex-wrap gap-1">
              {strip.map((code, i) => (
                <span key={i} title={String(code)} className={cn('h-3 w-3 rounded-[3px]', statusTone(code))} />
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <Card title="Live HTTP Response Headers Inspector" subtitle="Exact headers returned for the last decision">
          {last ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge tone={last.body.allowed ? 'green' : last.httpStatus === 402 ? 'violet' : 'red'}>HTTP {last.httpStatus}</Badge>
                {last.body.reason && <Badge tone="slate">{last.body.reason}</Badge>}
                <span className="text-xs text-slate-500">round-trip {fmtMs(last.rttMs)}</span>
              </div>
              <div className="overflow-hidden rounded-lg border border-slate-800">
                {Object.entries(last.headers).map(([name, value]) => (
                  <div key={name} className="grid grid-cols-[260px_1fr] border-b border-slate-800/80 font-mono text-xs last:border-0">
                    <span className="bg-slate-950/60 px-3 py-2 text-cyan-300">{name}</span>
                    <span className="truncate px-3 py-2 text-slate-200">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Fire a batch to inspect x-aegis-request-id, x-aegis-ratelimit-remaining and x-aegis-billing-cost-credits.</p>
          )}
        </Card>
        <GamePreview project={project} shield={shield} />
      </div>

      <BurstVisualizer />
    </div>
  );
}
