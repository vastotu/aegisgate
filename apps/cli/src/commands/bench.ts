import { AEGIS_HEADERS, type CheckRateLimitResponse } from '@aegisgate/shared';
import { bar, box, c, fit, fmt, padLeft, term, termWidth } from '../ansi';
import { errorMessage } from '../http';

export interface BenchOptions {
  gatewayUrl: string;
  apiKey: string;
  route: string;
  method: string;
  clientIp: string;
  requests: number;
  concurrency: number;
}

interface Sample {
  status: number | 'ERR';
  rttMs: number;
  gatewayMs?: number;
  costCredits: number;
  remainingBudget?: number;
  algorithm?: string;
  error?: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

async function fire(opts: BenchOptions): Promise<Sample> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${opts.gatewayUrl}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AEGIS_HEADERS.API_KEY]: opts.apiKey },
      body: JSON.stringify({ route: opts.route, method: opts.method, clientIp: opts.clientIp }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as Partial<CheckRateLimitResponse>;
    const tenantResolved = body.algorithm !== undefined && body.algorithm !== 'none';
    return {
      status: res.status,
      rttMs: performance.now() - t0,
      gatewayMs: body.gatewayLatencyMs,
      costCredits: body.allowed ? (body.costCredits ?? 0) : 0,
      remainingBudget: tenantResolved ? body.remainingBudgetCredits : undefined,
      algorithm: body.algorithm,
      error: body.allowed ? undefined : body.reason,
    };
  } catch (err) {
    return { status: 'ERR', rttMs: performance.now() - t0, costCredits: 0, error: errorMessage(err) };
  }
}

function renderProgress(done: number, total: number, startedAt: number): void {
  if (!process.stdout.isTTY) return;
  const elapsedSec = (performance.now() - startedAt) / 1000;
  const rps = elapsedSec > 0 ? done / elapsedSec : 0;
  const width = Math.min(40, termWidth() - 40);
  process.stdout.write(
    `${term.clearLine}  ${bar(done, total, width, c.cyan)} ${padLeft(done, String(total).length)}/${total}  ${padLeft(fmt.pct((done / total) * 100), 6)}  ${c.gray(`${rps.toFixed(0)} rps`)}`,
  );
}

function histogram(values: number[], buckets: number, width: number): string[] {
  if (values.length === 0) return [c.gray('no samples')];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min) / buckets || 1;
  const counts = new Array<number>(buckets).fill(0);
  for (const v of values) counts[Math.min(buckets - 1, Math.floor((v - min) / step))]!++;
  const peak = Math.max(...counts);
  return counts.map((count, i) => {
    const lo = min + i * step;
    const label = `${lo.toFixed(2).padStart(8)}–${(lo + step).toFixed(2).padEnd(8)}ms`;
    return `${c.gray(label)} ${bar(count, peak, width, c.blue)} ${padLeft(count, 5)}`;
  });
}

export async function runBench(opts: BenchOptions): Promise<void> {
  const width = Math.min(termWidth(), 110);
  process.stdout.write(
    `${box('AegisGate · Terminal Benchmark', [
      `${c.bold('Target')}       ${opts.gatewayUrl}/v1/check`,
      `${c.bold('Tenant key')}   ${opts.apiKey.slice(0, 16)}…`,
      `${c.bold('Route')}        ${opts.method} ${opts.route}  ${c.gray(`(client ${opts.clientIp})`)}`,
      `${c.bold('Load')}         ${opts.requests} requests · concurrency ${opts.concurrency}`,
    ], width).join('\n')}\n`,
  );

  const samples: Sample[] = [];
  let next = 0;
  const startedAt = performance.now();
  const worker = async (): Promise<void> => {
    while (next < opts.requests) {
      next++;
      samples.push(await fire(opts));
      renderProgress(samples.length, opts.requests, startedAt);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.requests)) }, worker));
  const elapsedMs = performance.now() - startedAt;
  if (process.stdout.isTTY) process.stdout.write('\n');

  const errors = samples.filter((s) => s.status === 'ERR');
  if (errors.length === samples.length) {
    process.stdout.write(
      `\n${c.red('✖ Gateway unreachable')} at ${opts.gatewayUrl} (${errors[0]?.error ?? 'unknown error'}).\n` +
        `  Start it with ${c.bold('npx pnpm@9.12.0 dev:gateway')} and re-run.\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  const count = (pred: (s: Sample) => boolean): number => samples.filter(pred).length;
  const ok = count((s) => s.status === 200);
  const limited = count((s) => s.status === 429);
  const budget = count((s) => s.status === 402);
  const other = samples.length - ok - limited - budget;
  const total = samples.length;
  const outcomeBar = width - 4 - 22 - 16;
  const outcomeLine = (label: string, n: number, paint: (s: string) => string) =>
    `${fit(label, 22)}${bar(n, total, outcomeBar, paint)} ${padLeft(fmt.int(n), 6)} ${padLeft(fmt.pct((n / total) * 100), 7)}`;

  const rtt = samples.map((s) => s.rttMs).sort((a, b) => a - b);
  const gw = samples.flatMap((s) => (s.gatewayMs !== undefined ? [s.gatewayMs] : [])).sort((a, b) => a - b);
  const pctHeader = `${fit('', 22)}${['P50', 'P90', 'P95', 'P99', 'MAX'].map((h) => padLeft(c.bold(h), 11)).join('')}`;
  const pctRow = (label: string, values: number[]) =>
    fit(label, 22) + [50, 90, 95, 99, 100].map((p) => padLeft(fmt.ms(percentile(values, p)), 11)).join('');

  const billed = samples.reduce((sum, s) => sum + s.costCredits, 0);
  const balances = samples.flatMap((s) => (s.remainingBudget !== undefined ? [s.remainingBudget] : []));
  const remaining = balances.length > 0 ? Math.min(...balances) : undefined;
  const algorithm = samples.find((s) => s.algorithm && s.algorithm !== 'none')?.algorithm ?? 'n/a';
  const otherReasons = [...new Set(samples.filter((s) => s.status !== 200 && s.status !== 429 && s.status !== 402).map((s) => `${s.status} ${s.error ?? ''}`.trim()))];

  const report = [
    ...box('Throughput', [
      `${fit('Requests', 22)}${fmt.int(total)}`,
      `${fit('Duration', 22)}${fmt.ms(elapsedMs)}`,
      `${fit('Throughput', 22)}${c.bold(c.cyan(`${(total / (elapsedMs / 1000)).toFixed(1)} req/s`))}`,
      `${fit('Algorithm', 22)}${algorithm}`,
    ], width),
    ...box('Decisions', [
      outcomeLine('200 OK  allowed', ok, c.green),
      outcomeLine('429 Rate Limited', limited, c.red),
      outcomeLine('402 Budget Exhausted', budget, c.magenta),
      ...(other > 0 ? [outcomeLine('Other / errors', other, c.yellow), c.gray(`  ${otherReasons.join(' · ')}`)] : []),
    ], width),
    ...box('Latency percentiles', [
      pctHeader,
      pctRow('Client round-trip', rtt),
      pctRow('Gateway (server-side)', gw),
    ], width),
    ...box('Client round-trip histogram', histogram(rtt, 8, width - 4 - 30 - 8), width),
    ...box('Billing', [
      `${fit('Credits billed', 22)}${c.bold(c.yellow(fmt.int(billed)))} credits`,
      `${fit('Remaining wallet', 22)}${remaining !== undefined ? c.bold(c.green(fmt.int(remaining))) + ' credits' : c.gray('n/a')}`,
    ], width),
  ];
  process.stdout.write(`${report.join('\n')}\n`);
}
