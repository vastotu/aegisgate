'use client';

import type { RateLimitAlgo, SimulationResult } from '@aegisgate/shared';
import { Activity, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { fmtInt, fmtPct } from '@/lib/format';
import { ALGORITHMS, gatewayClient } from '@/lib/gateway-client';
import { ALGO_STYLE, BurstChart } from './burst-chart';
import { Badge, Button, Card, Field, inputClass } from './ui';

function verdict(peak: number, limit: number, burst: number): { text: string; tone: 'red' | 'green' | 'cyan' } {
  if (peak > Math.max(limit, burst)) return { text: `✖ ${fmtPct((peak / limit) * 100, 0)} boundary leak`, tone: 'red' };
  if (peak <= limit) return { text: '✔ strict cap', tone: 'green' };
  return { text: '✔ burst-bounded', tone: 'cyan' };
}

export function BurstVisualizer() {
  const [limit, setLimit] = useState(100);
  const [burst, setBurst] = useState(120);
  const [requests, setRequests] = useState(200);
  const [windowSec, setWindowSec] = useState(60);
  const [results, setResults] = useState<Partial<Record<RateLimitAlgo, SimulationResult>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setResults(
        await gatewayClient.runBurstSimulation({
          limitCount: limit,
          windowSec,
          burstCapacity: burst,
          totalRequests: requests,
          scenario: 'boundary_burst',
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [limit, burst, requests, windowSec]);

  useEffect(() => {
    void run();
    // Run once on mount with the default attack scenario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card
      icon={<Activity className="h-4 w-4" />}
      title="Algorithm Boundary-Burst Visualizer"
      subtitle={`${requests} requests fired in the 200ms around the ${windowSec}s window boundary (t = ${windowSec - 0.1}s → ${windowSec + 0.1}s)`}
      actions={
        <Button variant="primary" onClick={() => void run()} disabled={busy}>
          <Play className="h-4 w-4" /> {busy ? 'Simulating…' : 'Run attack simulation'}
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Limit (req / window)">
          <input className={inputClass} type="number" min={1} value={limit} onChange={(e) => setLimit(Math.max(1, Number(e.target.value)))} />
        </Field>
        <Field label="Burst capacity">
          <input className={inputClass} type="number" min={1} value={burst} onChange={(e) => setBurst(Math.max(1, Number(e.target.value)))} />
        </Field>
        <Field label="Window (sec)">
          <input className={inputClass} type="number" min={1} value={windowSec} onChange={(e) => setWindowSec(Math.max(1, Number(e.target.value)))} />
        </Field>
        <Field label="Attack scenario (requests)">
          <input className={inputClass} type="number" min={1} max={20000} value={requests} onChange={(e) => setRequests(Math.max(1, Number(e.target.value)))} />
        </Field>
      </div>

      {error && <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <BurstChart results={results} limit={limit} burst={burst} />
          <div className="mt-2 flex flex-wrap gap-4 px-2 text-xs text-slate-400">
            {ALGORITHMS.map((a) => (
              <span key={a} className="inline-flex items-center gap-2">
                <span className="h-2 w-4 rounded-sm" style={{ backgroundColor: ALGO_STYLE[a].color }} /> {ALGO_STYLE[a].label}
              </span>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          {ALGORITHMS.map((a) => {
            const r = results[a];
            const v = r ? verdict(r.summary.peakBurstRate, limit, burst) : null;
            return (
              <div key={a} className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: ALGO_STYLE[a].color }}>
                    {ALGO_STYLE[a].label}
                  </span>
                  {v && <Badge tone={v.tone}>{v.text}</Badge>}
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-semibold tabular-nums text-slate-50">{r ? fmtInt(r.summary.peakBurstRate) : '—'}</span>
                  <span className="text-xs text-slate-500">peak admitted in any {windowSec}s window</span>
                </div>
                {r && (
                  <div className="mt-1 font-mono text-[11px] text-slate-500">
                    allowed {fmtInt(r.summary.allowed)} · blocked {fmtInt(r.summary.blocked)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
