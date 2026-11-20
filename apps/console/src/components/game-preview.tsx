'use client';

import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { projectEmoji } from '@/lib/format';
import type { ProjectView } from '@/lib/types';
import { Badge, cn } from './ui';

export type ShieldState =
  | { kind: 'idle' }
  | { kind: 'normal'; allowed: number }
  | { kind: 'ddos'; allowed: number; blocked: number }
  | { kind: 'speedhack'; sent: number; admitted: number; dropped: number };

export function GamePreview({ project, shield }: { project: ProjectView; shield: ShieldState }) {
  const isShark = project.slug === 'happyshark';
  const underAttack = shield.kind === 'ddos' || shield.kind === 'speedhack';
  const fps = shield.kind === 'speedhack' ? 120 : 60;
  const admittedFps = shield.kind === 'speedhack' ? Math.min(60, shield.admitted) : 60;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-b from-sky-950/60 via-slate-950 to-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-2.5">
        <span className="text-xs font-semibold text-slate-200">
          {projectEmoji(project.slug)} {isShark ? 'HappyShark.io · Room #42' : `${project.name} · Client`}
        </span>
        <Badge tone={underAttack ? 'amber' : 'green'}>🛡️ Protected by AegisGate</Badge>
      </div>

      <div className="relative h-36 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(56,189,248,0.25),transparent_55%),radial-gradient(circle_at_75%_70%,rgba(34,211,238,0.15),transparent_50%)]" />
        {isShark ? (
          <>
            <div className="absolute left-[18%] top-[30%] text-3xl">🦈</div>
            <div className="absolute left-[58%] top-[52%] text-2xl opacity-80">🐟</div>
            <div className="absolute left-[74%] top-[22%] text-xl opacity-70">🐠</div>
            {shield.kind === 'speedhack' && (
              <div className="absolute left-[30%] top-[38%] animate-pulse text-3xl opacity-40 blur-[1px]">🦈💨</div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-slate-500">{project.upstreamUrl}</div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-px border-t border-slate-800 bg-slate-800 text-center">
        {[
          ['Client FPS', `${fps}`],
          ['Admitted pkt/s', `${admittedFps}`],
          ['Cap', '60 FPS'],
        ].map(([label, value]) => (
          <div key={label} className="bg-slate-950 px-2 py-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
            <div className="font-mono text-sm text-slate-100">{value}</div>
          </div>
        ))}
      </div>

      <div
        className={cn(
          'flex items-start gap-3 border-t px-4 py-3 text-xs',
          underAttack ? 'border-amber-500/30 bg-amber-500/5 text-amber-100' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-100',
        )}
      >
        {underAttack ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />}
        <span>
          {shield.kind === 'idle' && 'Anti-cheat shield armed. Fire traffic to watch AegisGate decide in real time.'}
          {shield.kind === 'normal' && `Normal play: ${shield.allowed} requests admitted, no player throttled.`}
          {shield.kind === 'ddos' && `DDoS mitigated: ${shield.blocked} flood requests rejected at the edge, ${shield.allowed} admitted within the burst budget.`}
          {shield.kind === 'speedhack' &&
            `Speed-hack detected: ${shield.sent} pkt/s sent, ${shield.admitted} admitted, ${shield.dropped} movement packets dropped by the 60 FPS cap.`}
        </span>
      </div>
    </div>
  );
}
