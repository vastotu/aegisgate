'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CommandBar } from '@/components/command-bar';
import { FinOpsTab } from '@/components/finops-tab';
import { LedgerTab } from '@/components/ledger-tab';
import { NewProjectModal } from '@/components/new-project-modal';
import { RulesTab } from '@/components/rules-tab';
import { TrafficLab } from '@/components/traffic-lab';
import { cn } from '@/components/ui';
import { fmtInt, fmtPct, projectEmoji } from '@/lib/format';
import { gatewayClient } from '@/lib/gateway-client';
import type { ConnectionMode, CreatedProject, OverviewView } from '@/lib/types';

const TABS = [
  { id: 'traffic', label: '📡 Live Traffic & Chaos Lab' },
  { id: 'rules', label: '🔐 Dynamic Rules & SDK Integration' },
  { id: 'ledger', label: '📒 Double-Entry Billing Ledger' },
  { id: 'finops', label: '💰 FinOps & Pricing Simulator' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const REFRESH_MS = 2_500;

function useConnectionMode(): ConnectionMode {
  const [mode, setMode] = useState<ConnectionMode>('probing');
  useEffect(() => {
    setMode(gatewayClient.getMode());
    return gatewayClient.subscribe(setMode);
  }, []);
  return mode;
}

export default function ConsolePage() {
  const mode = useConnectionMode();
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState('happyshark');
  const [tab, setTab] = useState<TabId>('traffic');
  const [showNewProject, setShowNewProject] = useState(false);
  /** Raw keys issued during this session (the gateway only stores hashes). */
  const [issuedKeys, setIssuedKeys] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setOverview(await gatewayClient.fetchOverview());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const projects = overview?.projects ?? [];
  const project = projects.find((p) => p.slug === selectedSlug) ?? projects[0];
  const apiKey = project ? (issuedKeys[project.slug] ?? project.demoApiKey) : null;

  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const deleteSelectedProject = async () => {
    if (!project || project.isShowcaseTenant) return;
    const ok = window.confirm(`Delete "${project.name}"? Its API key, rules, usage logs and ledger journal are removed permanently.`);
    if (!ok) return;
    setDeleting(true);
    setActionError(null);
    try {
      await gatewayClient.deleteProject(project.id);
      const slug = project.slug;
      setIssuedKeys(({ [slug]: _removed, ...rest }) => rest);
      setSelectedSlug('happyshark');
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const onCreated = (created: CreatedProject) => {
    setIssuedKeys((keys) => ({ ...keys, [created.project.slug]: created.apiKey }));
    setSelectedSlug(created.project.slug);
    void refresh();
  };

  return (
    <div className="bg-grid min-h-screen">
      <CommandBar
        projects={projects}
        selectedSlug={project?.slug ?? selectedSlug}
        onSelect={setSelectedSlug}
        onNewProject={() => setShowNewProject(true)}
        onDeleteProject={() => void deleteSelectedProject()}
        deleting={deleting}
        mode={mode}
        dataSource={overview?.dataSource}
        gatewayUrl={gatewayClient.gatewayUrl}
      />

      <main className="mx-auto max-w-[1400px] px-6 py-6">
        {project && overview ? (
          <>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500">Workspace</div>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
                  {projectEmoji(project.slug)} {project.name}
                </h1>
                <p className="mt-1 text-sm text-slate-400">{project.description ?? project.upstreamUrl}</p>
              </div>
              <div className="flex flex-wrap gap-6 font-mono text-sm">
                <Stat label="Wallet" value={fmtInt(project.walletBalanceCredits - project.pendingUnsettledCredits)} tone="text-emerald-300" />
                <Stat label="Requests" value={fmtInt(project.finops.totalRequests)} tone="text-slate-100" />
                <Stat label="Blocked" value={fmtInt(project.finops.blockedRequests)} tone="text-rose-300" />
                <Stat label="Gross margin" value={fmtPct(project.finops.grossMarginPct)} tone="text-cyan-300" />
                <button type="button" onClick={() => void refresh()} className="self-end rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200" aria-label="Refresh">
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </div>

            <nav className="mb-6 flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-ink-900/70 p-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition',
                    tab === t.id ? 'bg-slate-800 text-slate-50 shadow-inner shadow-black/40' : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {error && <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}
            {actionError && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                <span>{actionError}</span>
                <button type="button" onClick={() => setActionError(null)} className="text-xs text-rose-300 hover:text-rose-100">
                  Dismiss
                </button>
              </div>
            )}

            {tab === 'traffic' && <TrafficLab project={project} apiKey={apiKey} worker={overview.worker} onTraffic={() => void refresh()} />}
            {tab === 'rules' && <RulesTab project={project} apiKey={apiKey} onMutated={() => void refresh()} />}
            {tab === 'ledger' && <LedgerTab project={project} overview={overview} onMutated={() => void refresh()} />}
            {tab === 'finops' && <FinOpsTab project={project} />}
          </>
        ) : (
          <div className="flex h-[60vh] items-center justify-center text-sm text-slate-500">
            {error ? `Failed to load: ${error}` : 'Connecting to AegisGate…'}
          </div>
        )}
      </main>

      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreated={onCreated} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <div className="font-sans text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}
