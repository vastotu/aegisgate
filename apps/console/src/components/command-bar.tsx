'use client';

import { ChevronDown, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { projectEmoji } from '@/lib/format';
import type { ConnectionMode, DataSource, ProjectView } from '@/lib/types';
import { Badge, Button, cn } from './ui';

function StatusPill({ mode, dataSource, gatewayUrl }: { mode: ConnectionMode; dataSource?: DataSource; gatewayUrl: string }) {
  if (mode === 'probing') {
    return <span className="rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs text-slate-400">Connecting to gateway…</span>;
  }
  if (mode === 'sandbox') {
    return (
      <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-200">
        ⚡ Standalone Edge Sandbox Active (In-Browser Engine)
      </span>
    );
  }
  const port = (() => {
    try {
      return new URL(gatewayUrl).port || '80';
    } catch {
      return '4000';
    }
  })();
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-200">
      🟢 Live Gateway Connected (:{port})
      {dataSource === 'offline-showcase' && <span className="rounded bg-amber-400/15 px-1.5 text-[10px] text-amber-200">Postgres offline · in-memory store</span>}
    </span>
  );
}

export function CommandBar({
  projects,
  selectedSlug,
  onSelect,
  onNewProject,
  onDeleteProject,
  deleting,
  mode,
  dataSource,
  gatewayUrl,
}: {
  projects: ProjectView[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  onNewProject: () => void;
  onDeleteProject: () => void;
  deleting: boolean;
  mode: ConnectionMode;
  dataSource?: DataSource;
  gatewayUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = projects.find((p) => p.slug === selectedSlug);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-ink-950/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-4 px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="glow-cyan rounded-lg bg-gradient-to-br from-cyan-400/20 to-violet-500/20 p-2 text-cyan-300">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-slate-50">🛡️ AegisGate</div>
            <div className="truncate text-[11px] text-slate-400">
              Cloud-Native Distributed API Gateway, Rate-Limiter &amp; Usage-Based Billing Engine
            </div>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <StatusPill mode={mode} dataSource={dataSource} gatewayUrl={gatewayUrl} />

          <div ref={ref} className="relative">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex min-w-[260px] items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 transition hover:border-slate-600"
            >
              <span className="truncate">
                {selected ? `${projectEmoji(selected.slug)} ${selected.name}` : 'Select workspace'}
              </span>
              <ChevronDown className={cn('h-4 w-4 text-slate-400 transition', open && 'rotate-180')} />
            </button>
            {open && (
              <div className="absolute right-0 z-40 mt-2 w-[320px] overflow-hidden rounded-xl border border-slate-700 bg-ink-900 shadow-2xl shadow-black/50">
                <div className="border-b border-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Workspaces / Tenants
                </div>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onSelect(p.slug);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-slate-800/70',
                      p.slug === selectedSlug && 'bg-slate-800/50',
                    )}
                  >
                    <span className="truncate text-slate-100">
                      {projectEmoji(p.slug)} {p.name}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">{p.slug}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected &&
            (selected.isShowcaseTenant ? (
              <span title="Built-in demo tenants are locked so the live showcase stays intact. Custom projects can be deleted.">
                <Badge tone="slate">🔒 Protected Showcase Tenant</Badge>
              </span>
            ) : (
              <Button variant="danger" onClick={onDeleteProject} disabled={deleting}>
                {deleting ? 'Deleting…' : '🗑️ Delete Project'}
              </Button>
            ))}

          <Button variant="primary" onClick={onNewProject}>
            <Plus className="h-4 w-4" /> New Project / Onboard API
          </Button>
        </div>
      </div>
    </header>
  );
}
