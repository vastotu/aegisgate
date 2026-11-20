'use client';

import { KeyRound, Rocket, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { slugify } from '@/lib/format';
import { gatewayClient } from '@/lib/gateway-client';
import { sdkSnippets } from '@/lib/snippets';
import type { CreatedProject } from '@/lib/types';
import { CodeTabs } from './code-tabs';
import { Badge, Button, CopyButton, Field, inputClass } from './ui';

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (created: CreatedProject) => void }) {
  const [name, setName] = useState('NTU Course Helper');
  const [slug, setSlug] = useState('ntu-course-helper');
  const [slugTouched, setSlugTouched] = useState(false);
  const [upstreamUrl, setUpstreamUrl] = useState('https://api.example.com');
  const [budget, setBudget] = useState(100_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedProject | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await gatewayClient.createProject({ name, slug, upstreamUrl, monthlyBudgetCredits: budget });
      setCreated(result);
      onCreated(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="mt-10 w-full max-w-2xl rounded-2xl border border-slate-700 bg-ink-900 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Rocket className="h-4 w-4 text-cyan-300" /> Onboard a new API project
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!created ? (
          <form onSubmit={submit} className="space-y-4 px-6 py-5">
            <Field label="Project name">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Slug" hint="Used in WALLET:<slug>, the API key and /proxy/<slug>/*">
                <input
                  className={inputClass}
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                  pattern="[a-z0-9][a-z0-9-]{1,47}"
                  required
                />
              </Field>
              <Field label="Monthly prepaid budget (credits)">
                <input className={inputClass} type="number" min={1} step={1000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} required />
              </Field>
            </div>
            <Field label="Upstream URL" hint="*.example.com upstreams get a synthetic response in proxy mode">
              <input className={inputClass} type="url" value={upstreamUrl} onChange={(e) => setUpstreamUrl(e.target.value)} required />
            </Field>
            {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Provisioning…' : 'Create project & generate key'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-5 px-6 py-5">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-200">
                <KeyRound className="h-4 w-4" /> {created.project.name} is live
                <Badge tone="green">+{created.initialCredits.toLocaleString('en-US')} credits funded</Badge>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 truncate rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-cyan-200">{created.apiKey}</code>
                <CopyButton text={created.apiKey} />
              </div>
              <p className="mt-2 text-xs text-slate-400">Copy it now: only the SHA-256 hash and prefix are stored server-side.</p>
            </div>
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">3-line @aegisgate/sdk integration</div>
              <CodeTabs
                snippets={sdkSnippets({ apiKey: created.apiKey, slug: created.project.slug, gatewayUrl: gatewayClient.gatewayUrl, route: '/api' })}
              />
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onClick={onClose}>
                Open {created.project.slug} workspace
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
