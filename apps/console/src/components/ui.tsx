'use client';

import { Check, Copy } from 'lucide-react';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export const cn = (...classes: Array<string | false | null | undefined>): string => classes.filter(Boolean).join(' ');

export function Card({
  title,
  subtitle,
  icon,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-slate-800/80 bg-ink-900/70 backdrop-blur', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800/80 px-5 py-4">
          <div className="flex items-start gap-3">
            {icon && <div className="mt-0.5 rounded-md border border-slate-700/60 bg-slate-800/60 p-1.5 text-cyan-300">{icon}</div>}
            <div>
              <h3 className="text-sm font-semibold tracking-tight text-slate-100">{title}</h3>
              {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
            </div>
          </div>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export type Tone = 'green' | 'red' | 'amber' | 'cyan' | 'violet' | 'slate';

const TONES: Record<Tone, string> = {
  green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  red: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  cyan: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  violet: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  slate: 'border-slate-600/50 bg-slate-800/60 text-slate-300',
};

const TONE_TEXT: Record<Tone, string> = {
  green: 'text-emerald-300',
  red: 'text-rose-300',
  amber: 'text-amber-300',
  cyan: 'text-cyan-300',
  violet: 'text-violet-300',
  slate: 'text-slate-100',
};

export function Badge({ tone = 'slate', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium', TONES[tone], className)}>
      {children}
    </span>
  );
}

const BUTTON_VARIANTS = {
  primary: 'bg-cyan-400 text-slate-950 hover:bg-cyan-300',
  danger: 'bg-rose-500 text-white hover:bg-rose-400',
  warning: 'bg-amber-400 text-slate-950 hover:bg-amber-300',
  ghost: 'border border-slate-700 bg-slate-800/50 text-slate-200 hover:border-slate-600 hover:bg-slate-700/60',
} as const;

export function Button({
  variant = 'ghost',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Kpi({ label, value, hint, tone = 'slate', icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-ink-900/70 p-4">
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-slate-400">
        <span>{label}</span>
        {icon && <span className="text-slate-500">{icon}</span>}
      </div>
      <div className={cn('mt-2 font-mono text-2xl font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-200"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-[#060910] p-4 pr-24 font-mono text-[12.5px] leading-relaxed text-slate-300">
        <code>{code}</code>
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 font-mono text-sm text-slate-100 outline-none ring-cyan-500/30 placeholder:text-slate-600 focus:border-cyan-500/60 focus:ring-2';
