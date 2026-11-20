import { SHOWCASE_TENANTS } from '@aegisgate/shared';

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export const fmtUsd = (n: number, digits = 2): string =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const fmtPct = (n: number, digits = 1): string => `${Number.isFinite(n) ? n.toFixed(digits) : '0.0'}%`;

export const fmtMs = (n: number): string => (n < 1 ? `${Math.round(n * 1000)}µs` : `${n.toFixed(2)}ms`);

export const shortHash = (hash: string, n = 10): string => (hash.startsWith('GENESIS') ? 'GENESIS' : hash.slice(0, n));

export const timeOf = (value: string | number): string =>
  new Date(value).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export const projectEmoji = (slug: string): string => SHOWCASE_TENANTS.find((t) => t.slug === slug)?.emoji ?? '🧩';

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
