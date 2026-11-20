'use client';

import type { RateLimitAlgo, SimulationResult } from '@aegisgate/shared';

export const ALGO_STYLE: Record<RateLimitAlgo, { label: string; color: string }> = {
  fixed_window: { label: 'Fixed Window', color: '#fb7185' },
  sliding_window: { label: 'Sliding Window', color: '#34d399' },
  token_bucket: { label: 'Token Bucket', color: '#22d3ee' },
};

const W = 720;
const H = 280;
const PAD = { l: 48, r: 20, t: 18, b: 36 };

/** Cumulative admitted requests across the window boundary, one step line per algorithm. */
export function BurstChart({
  results,
  limit,
  burst,
}: {
  results: Partial<Record<RateLimitAlgo, SimulationResult>>;
  limit: number;
  burst: number;
}) {
  const series = (Object.keys(ALGO_STYLE) as RateLimitAlgo[]).flatMap((algo) => {
    const r = results[algo];
    if (!r) return [];
    let acc = 0;
    return [{ algo, points: r.timeline.map((t) => (acc += t.allowed)) }];
  });
  const first = series.length ? results[series[0]!.algo]! : undefined;
  if (!first) return <div className="flex h-[280px] items-center justify-center text-sm text-slate-500">Run the simulation to render the chart</div>;

  let requested = 0;
  const requestedPoints = first.timeline.map((t) => (requested += t.requested));
  const ticks = first.timeline.length;
  const maxY = Math.max(requested, burst, limit, ...series.flatMap((s) => s.points)) * 1.08;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (i / ticks) * innerW;
  const y = (v: number) => PAD.t + innerH - (v / maxY) * innerH;
  const stepPath = (points: number[]) =>
    points.reduce((d, v, i) => `${d} L${x(i).toFixed(1)},${y(v).toFixed(1)} L${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`, `M${x(0)},${y(0)}`);

  const boundaryX = x(ticks / 2);
  const startSec = (first.timeline[0]!.tickMs / 1000).toFixed(1);
  const boundarySec = (first.timeline[Math.floor(ticks / 2)]!.tickMs / 1000).toFixed(1);
  const endSec = ((first.timeline[ticks - 1]!.tickMs + (first.timeline[1]!.tickMs - first.timeline[0]!.tickMs)) / 1000).toFixed(1);
  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxY));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Cumulative admitted requests per algorithm">
      {gridValues.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#1e293b" strokeDasharray="2 4" />
          <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="fill-slate-500 font-mono text-[10px]">
            {v}
          </text>
        </g>
      ))}
      <line x1={boundaryX} x2={boundaryX} y1={PAD.t} y2={H - PAD.b} stroke="#fbbf24" strokeDasharray="4 4" />
      <text x={boundaryX + 6} y={PAD.t + 12} className="fill-amber-300 font-mono text-[10px]">
        t = {boundarySec}s window boundary
      </text>

      <line x1={PAD.l} x2={W - PAD.r} y1={y(limit)} y2={y(limit)} stroke="#a78bfa" strokeDasharray="6 3" />
      <text x={W - PAD.r} y={y(limit) - 5} textAnchor="end" className="fill-violet-300 font-mono text-[10px]">
        limit {limit}
      </text>
      {burst !== limit && (
        <>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(burst)} y2={y(burst)} stroke="#22d3ee" strokeOpacity={0.4} strokeDasharray="2 3" />
          <text x={W - PAD.r} y={y(burst) - 5} textAnchor="end" className="fill-cyan-300/70 font-mono text-[10px]">
            burst {burst}
          </text>
        </>
      )}

      <path d={stepPath(requestedPoints)} fill="none" stroke="#475569" strokeWidth={1.5} strokeDasharray="3 3" />
      {series.map((s) => (
        <path key={s.algo} d={stepPath(s.points)} fill="none" stroke={ALGO_STYLE[s.algo].color} strokeWidth={2.5} strokeLinejoin="round" />
      ))}

      <text x={PAD.l} y={H - 12} className="fill-slate-500 font-mono text-[10px]">
        {startSec}s
      </text>
      <text x={W - PAD.r} y={H - 12} textAnchor="end" className="fill-slate-500 font-mono text-[10px]">
        {endSec}s
      </text>
      <text x={PAD.l + innerW / 4} y={H - 12} textAnchor="middle" className="fill-slate-600 font-mono text-[10px]">
        attack traffic (dashed) vs admitted (solid), cumulative
      </text>
    </svg>
  );
}
