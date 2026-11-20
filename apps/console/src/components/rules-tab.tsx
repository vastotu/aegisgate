'use client';

import { RateLimitAlgoSchema, type RateLimitAlgo } from '@aegisgate/shared';
import { Code2, ListChecks, Save, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { fmtInt } from '@/lib/format';
import { gatewayClient } from '@/lib/gateway-client';
import { primaryRoute } from '@/lib/routes';
import { integrationSnippets } from '@/lib/snippets';
import type { ProjectView, RuleView } from '@/lib/types';
import { CodeTabs } from './code-tabs';
import { Badge, Button, Card, Field, inputClass } from './ui';

const METHODS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ALGO_TONE: Record<string, 'cyan' | 'green' | 'red'> = { token_bucket: 'cyan', sliding_window: 'green', fixed_window: 'red' };

interface RuleForm {
  routePattern: string;
  httpMethod: string;
  algorithm: RateLimitAlgo;
  limitCount: number;
  windowSec: number;
  burstCapacity: number;
  costWeightCredits: number;
  priority: number;
}

const EXAMPLE_RULE: RuleForm = {
  routePattern: '/api/export-pdf',
  httpMethod: 'ALL',
  algorithm: 'token_bucket',
  limitCount: 10,
  windowSec: 60,
  burstCapacity: 10,
  costWeightCredits: 50,
  priority: 10,
};

const toForm = (r: RuleView): RuleForm => ({
  routePattern: r.routePattern,
  httpMethod: r.httpMethod,
  algorithm: RateLimitAlgoSchema.safeParse(r.algorithm).data ?? 'token_bucket',
  limitCount: r.limitCount,
  windowSec: r.windowSec,
  burstCapacity: r.burstCapacity,
  costWeightCredits: r.costWeightCredits,
  priority: r.priority,
});

export function RulesTab({ project, apiKey, onMutated }: { project: ProjectView; apiKey: string | null; onMutated: () => void }) {
  const [form, setForm] = useState<RuleForm>(EXAMPLE_RULE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const wildcardCount = project.rateLimitRules.filter((r) => r.routePattern === '*').length;

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const removeRule = async (rule: RuleView) => {
    setDeletingId(rule.id);
    setMessage(null);
    try {
      await gatewayClient.deleteRule(project.id, rule.id);
      setMessage({ tone: 'green', text: `Rule deleted: ${rule.httpMethod} ${rule.routePattern} (L1 tenant cache invalidated)` });
      onMutated();
    } catch (err) {
      setMessage({ tone: 'red', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setDeletingId(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { action, rule } = await gatewayClient.createRule({ projectSlug: project.slug, ...form });
      setMessage({ tone: 'green', text: `Rule ${action}: ${rule.httpMethod} ${rule.routePattern} (L1 tenant cache invalidated)` });
      onMutated();
    } catch (err) {
      setMessage({ tone: 'red', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const key = apiKey ?? '<YOUR_API_KEY>';
  const snippets = integrationSnippets({ apiKey: key, slug: project.slug, gatewayUrl: gatewayClient.gatewayUrl, route: primaryRoute(project) });

  return (
    <div className="space-y-6">
      <Card icon={<ListChecks className="h-4 w-4" />} title="Active rate-limit rules" subtitle="Matched exact route → prefix wildcard → *, highest priority first. Click a row to edit it.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-2 pr-4 font-medium">Route pattern</th>
                <th className="py-2 pr-4 font-medium">Method</th>
                <th className="py-2 pr-4 font-medium">Algorithm</th>
                <th className="py-2 pr-4 text-right font-medium">Limit / window</th>
                <th className="py-2 pr-4 text-right font-medium">Burst</th>
                <th className="py-2 pr-4 text-right font-medium">Cost (credits)</th>
                <th className="py-2 pr-4 text-right font-medium">Priority</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[13px]">
              {project.rateLimitRules.map((r) => (
                <tr key={r.id} onClick={() => setForm(toForm(r))} className="cursor-pointer border-b border-slate-800/60 transition hover:bg-slate-800/40">
                  <td className="py-2.5 pr-4 text-cyan-200">{r.routePattern}</td>
                  <td className="py-2.5 pr-4 text-slate-400">{r.httpMethod}</td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={ALGO_TONE[r.algorithm] ?? 'slate'}>{r.algorithm}</Badge>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-slate-200">
                    {fmtInt(r.limitCount)} / {r.windowSec}s
                  </td>
                  <td className="py-2.5 pr-4 text-right text-slate-300">{fmtInt(r.burstCapacity)}</td>
                  <td className="py-2.5 pr-4 text-right text-amber-200">{fmtInt(r.costWeightCredits)}</td>
                  <td className="py-2.5 pr-4 text-right text-slate-400">{r.priority}</td>
                  <td className="py-2.5 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeRule(r);
                      }}
                      disabled={(r.routePattern === '*' && wildcardCount <= 1) || deletingId !== null}
                      title={r.routePattern === '*' && wildcardCount <= 1 ? "The last '*' fallback rule keeps a baseline limit" : 'Delete rule'}
                      aria-label={`Delete rule ${r.routePattern}`}
                      className="rounded-md p-1.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {project.rateLimitRules.length === 0 && <p className="py-4 text-sm text-slate-500">No rules: the gateway default (token_bucket 100/60s, burst 120) applies.</p>}
        </div>
      </Card>

      <Card icon={<Save className="h-4 w-4" />} title="Add / update a route rule" subtitle="Upserts by route pattern + method and takes effect on the next request">
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-4">
          <Field label="Route pattern" hint="'*', exact path, or prefix ending in '*'">
            <input className={inputClass} value={form.routePattern} onChange={(e) => set('routePattern', e.target.value)} required />
          </Field>
          <Field label="HTTP method">
            <select className={inputClass} value={form.httpMethod} onChange={(e) => set('httpMethod', e.target.value)}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Algorithm">
            <select className={inputClass} value={form.algorithm} onChange={(e) => set('algorithm', e.target.value as RateLimitAlgo)}>
              {RateLimitAlgoSchema.options.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <input className={inputClass} type="number" value={form.priority} onChange={(e) => set('priority', Number(e.target.value))} />
          </Field>
          <Field label="Limit count">
            <input className={inputClass} type="number" min={1} value={form.limitCount} onChange={(e) => set('limitCount', Number(e.target.value))} />
          </Field>
          <Field label="Window (sec)">
            <input className={inputClass} type="number" min={1} value={form.windowSec} onChange={(e) => set('windowSec', Number(e.target.value))} />
          </Field>
          <Field label="Burst capacity">
            <input className={inputClass} type="number" min={1} value={form.burstCapacity} onChange={(e) => set('burstCapacity', Number(e.target.value))} />
          </Field>
          <Field label="Cost weight (credits)">
            <input className={inputClass} type="number" min={0} value={form.costWeightCredits} onChange={(e) => set('costWeightCredits', Number(e.target.value))} />
          </Field>
          <div className="flex flex-wrap items-center gap-3 md:col-span-4">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save rule'}
            </Button>
            <Button onClick={() => setForm(EXAMPLE_RULE)}>Load example (/api/export-pdf · 50 credits)</Button>
            {message && <Badge tone={message.tone}>{message.text}</Badge>}
          </div>
        </form>
      </Card>

      <Card icon={<Code2 className="h-4 w-4" />} title="Connect this project" subtitle={apiKey ? 'Snippets include this project’s live key' : 'Replace <YOUR_API_KEY> with the key issued at onboarding'}>
        <CodeTabs snippets={snippets} />
      </Card>
    </div>
  );
}
