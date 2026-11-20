'use client';

import { fmtUsd } from '@/lib/format';

export interface WaterfallStep {
  label: string;
  value: number;
  kind: 'total' | 'delta' | 'result' | 'ghost';
}

const W = 720;
const H = 260;
const PAD = { l: 64, r: 16, t: 24, b: 44 };

/** Revenue → costs → net profit waterfall; `ghost` steps are drawn outlined (e.g. avoided DDoS cost). */
export function WaterfallChart({ steps }: { steps: WaterfallStep[] }) {
  let running = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') {
      running = s.value;
      return { ...s, from: 0, to: s.value };
    }
    if (s.kind === 'delta') {
      const from = running;
      running += s.value;
      return { ...s, from, to: running };
    }
    if (s.kind === 'result') return { ...s, from: 0, to: running };
    return { ...s, from: 0, to: s.value };
  });

  const values = bars.flatMap((b) => [b.from, b.to, 0]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ((max - v) / (max - min)) * innerH;
  const slot = innerW / bars.length;
  const barW = Math.min(90, slot * 0.6);

  const color = (b: (typeof bars)[number]): string => {
    if (b.kind === 'ghost') return '#a78bfa';
    if (b.kind === 'total') return '#34d399';
    if (b.kind === 'result') return b.to >= 0 ? '#22d3ee' : '#fb7185';
    return b.value >= 0 ? '#34d399' : '#fb7185';
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Monthly unit economics waterfall">
      <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#334155" />
      {[max, (max + min) / 2, min].map((v, i) => (
        <text key={i} x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="fill-slate-500 font-mono text-[10px]">
          {fmtUsd(v, 0)}
        </text>
      ))}
      {bars.map((b, i) => {
        const x = PAD.l + slot * i + (slot - barW) / 2;
        const top = y(Math.max(b.from, b.to));
        const height = Math.max(2, Math.abs(y(b.from) - y(b.to)));
        const fill = color(b);
        const next = bars[i + 1];
        return (
          <g key={b.label}>
            <rect
              x={x}
              y={top}
              width={barW}
              height={height}
              rx={4}
              fill={b.kind === 'ghost' ? 'transparent' : fill}
              fillOpacity={0.85}
              stroke={fill}
              strokeDasharray={b.kind === 'ghost' ? '4 3' : undefined}
            />
            {next && next.kind === 'delta' && (
              <line x1={x + barW} x2={x + slot} y1={y(b.to)} y2={y(b.to)} stroke="#475569" strokeDasharray="2 3" />
            )}
            <text x={x + barW / 2} y={top - 6} textAnchor="middle" className="fill-slate-200 font-mono text-[11px]">
              {fmtUsd(b.kind === 'result' ? b.to : b.value, 0)}
            </text>
            <text x={x + barW / 2} y={H - 22} textAnchor="middle" className="fill-slate-400 text-[11px]">
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
