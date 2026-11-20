import * as readline from 'node:readline';
import { bar, box, c, fit, fmt, padLeft, sideBySide, term, termHeight, termWidth } from '../ansi';
import { errorMessage, requestJson } from '../http';
import type { OverviewProject, OverviewResponse } from '../types';

export interface TopOptions {
  gatewayUrl: string;
  once: boolean;
  intervalMs: number;
}

interface TopState {
  overview?: OverviewResponse;
  error?: string;
  fetchMs?: number;
}

const LEDGER_ROWS = 6;

function statusBadge(code: number): string {
  if (code < 400) return c.green(`[${code} OK]`);
  if (code === 429) return c.red('[429 BLOCKED]');
  if (code === 402) return c.magenta('[402 BUDGET]');
  return c.yellow(`[${code}]`);
}

function marginColor(pct: number): (s: string) => string {
  if (pct >= 50) return c.green;
  if (pct >= 0) return c.yellow;
  return c.red;
}

function tenantRow(p: OverviewProject): string {
  const live = p.walletBalanceCredits - p.pendingUnsettledCredits;
  const ratio = p.monthlyBudgetCredits > 0 ? live / p.monthlyBudgetCredits : 0;
  const walletPaint = ratio > 0.25 ? c.green : ratio > 0.1 ? c.yellow : c.red;
  const f = p.finops;
  return (
    fit(c.bold(p.name), 27) +
    padLeft(walletPaint(fmt.int(live)), 11) +
    ' ' +
    bar(live, p.monthlyBudgetCredits, 10, walletPaint) +
    padLeft(fmt.int(f.totalRequests), 8) +
    padLeft(c.green(fmt.int(f.allowedRequests)), 8) +
    padLeft(c.red(fmt.int(f.blockedRequests)), 8) +
    padLeft(fmt.ms(f.p95LatencyMs), 9) +
    padLeft(fmt.usd(f.grossRevenueUsd), 10) +
    padLeft(marginColor(f.grossMarginPct)(fmt.pct(f.grossMarginPct)), 8)
  );
}

function render(state: TopState, opts: TopOptions, width: number, height: number): string[] {
  const ov = state.overview;
  const source = !ov
    ? c.red('unreachable')
    : ov.dataSource === 'offline-showcase'
      ? c.yellow('offline-showcase (Postgres down)')
      : c.green(ov.dataSource ?? 'postgres');
  const lines: string[] = [
    `${c.bold(c.cyan('◆ AEGISGATE'))} ${c.bold('LIVE TELEMETRY WAR-ROOM')}  ${c.gray(opts.gatewayUrl)}  source: ${source}  ${c.gray(new Date().toISOString().slice(11, 19))}${opts.once ? '' : c.gray('  [q] quit')}`,
  ];

  if (!ov) {
    lines.push(
      ...box('Gateway', [
        c.red(`✖ ${state.error ?? 'no data yet'}`),
        `Start it with ${c.bold('npx pnpm@9.12.0 dev:gateway')}${opts.once ? '' : ` · retrying every ${(opts.intervalMs / 1000).toFixed(1)}s`}`,
      ], width),
    );
    return lines;
  }
  if (state.error) lines.push(c.yellow(`⚠ last refresh failed (${state.error}); showing previous snapshot`));

  // Top pane: tenants + FinOps.
  const tenantHeader =
    fit(c.bold('TENANT'), 27) +
    padLeft(c.bold('WALLET'), 11) +
    ' ' +
    fit(c.bold('BUDGET'), 10) +
    padLeft(c.bold('REQS'), 8) +
    padLeft(c.bold('ALLOW'), 8) +
    padLeft(c.bold('BLOCK'), 8) +
    padLeft(c.bold('P95'), 9) +
    padLeft(c.bold('REVENUE'), 10) +
    padLeft(c.bold('MARGIN'), 8);
  const pf = ov.platform.finops;
  const platformRow =
    fit(c.cyan('Platform total'), 27) +
    padLeft(c.cyan(fmt.int(ov.platform.revenueBalanceCredits)), 11) +
    ' ' +
    fit(c.gray('revenue cr'), 10) +
    padLeft(fmt.int(pf.totalRequests), 8) +
    padLeft(c.green(fmt.int(pf.allowedRequests)), 8) +
    padLeft(c.red(fmt.int(pf.blockedRequests)), 8) +
    padLeft(fmt.ms(pf.p95LatencyMs), 9) +
    padLeft(fmt.usd(pf.grossRevenueUsd), 10) +
    padLeft(marginColor(pf.grossMarginPct)(fmt.pct(pf.grossMarginPct)), 8);
  lines.push(...box(`Protected Tenants (${ov.projects.length})`, [tenantHeader, ...ov.projects.map(tenantRow), platformRow], width));

  // Middle pane: write-behind buffer + hash-chained ledger.
  const slugById = new Map(ov.projects.map((p) => [p.id, p.slug]));
  const w = ov.worker;
  const leftWidth = Math.floor(width * 0.36);
  const left = box('Write-Behind Ring Buffer', [
    `Buffered  ${bar(w.bufferSize, w.maxBufferSize, 12, w.bufferSize > w.maxBufferSize * 0.8 ? c.red : c.cyan)} ${w.bufferSize}/${w.maxBufferSize}`,
    `Batches flushed   ${c.bold(fmt.int(w.totalBatchesFlushed))}`,
    `Live events held  ${fmt.int(w.recentLiveEvents.length)}/200`,
    `Platform margin   ${marginColor(pf.grossMarginPct)(fmt.pct(pf.grossMarginPct))}`,
    `Infra cost        ${fmt.usd(pf.infraCostUsd)}`,
    `Fetch latency     ${state.fetchMs !== undefined ? fmt.ms(state.fetchMs) : 'n/a'}`,
  ], leftWidth);

  const entries = ov.projects
    .flatMap((p) => p.recentLedgerEntries)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, LEDGER_ROWS);
  const ledgerRows = entries.length
    ? entries.map(
        (e) =>
          `${c.gray(fmt.time(e.createdAt).slice(0, 8))} ${fit(slugById.get(e.projectId) ?? '?', 12)} ` +
          `${(e.direction === 'DEBIT' ? c.red : c.green)(fit(e.direction, 6))}${padLeft(fmt.int(e.amountCredits), 9)} ` +
          `${c.gray('bal')} ${padLeft(fmt.int(e.balanceAfter), 10)} ${c.gray(`${e.prevHash.slice(0, 6)}…→${e.entryHash.slice(0, 8)}`)}`,
      )
    : [c.gray('No ledger entries yet')];
  const right = box('Double-Entry Ledger · SHA-256 chain', ledgerRows, width - leftWidth - 1);
  lines.push(...sideBySide(left, right, leftWidth));

  // Bottom pane: live request tail sized to the remaining height.
  const tailRows = Math.max(3, height - lines.length - 2);
  const events = w.recentLiveEvents.slice(0, tailRows);
  const tail = events.length
    ? events.map(
        (e) =>
          `${c.gray(fmt.time(e.timestamp))} ${fit(statusBadge(e.statusCode), 13)} ${fit(e.method, 5)} ${fit(e.route, 26)}` +
          `${padLeft(fmt.ms(e.latencyMs), 9)}${padLeft(`${e.costCredits}cr`, 7)}  ${c.gray(fit(e.clientIp, 15))} ${c.cyan(slugById.get(e.projectId) ?? '')}`,
      )
    : [c.gray(`No live traffic yet. Generate some with ${c.bold('npx pnpm@9.12.0 cli:bench')}`)];
  lines.push(...box('Live Request Tail', tail, width));
  return lines;
}

export async function runTop(opts: TopOptions): Promise<void> {
  const state: TopState = {};
  const refresh = async (): Promise<void> => {
    const t0 = performance.now();
    try {
      const res = await requestJson<OverviewResponse>(`${opts.gatewayUrl}/v1/admin/overview`, { timeoutMs: 1_200 });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      state.overview = res.body;
      state.fetchMs = performance.now() - t0;
      state.error = undefined;
    } catch (err) {
      state.error = errorMessage(err);
    }
  };

  if (opts.once) {
    await refresh();
    process.stdout.write(`${render(state, opts, termWidth(), Math.max(termHeight(), 40)).join('\n')}\n`);
    if (!state.overview) process.exitCode = 1;
    return;
  }

  const out = process.stdout;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const exit = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    out.write(term.showCursor + term.altOff);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.once('SIGINT', exit);
  process.once('SIGTERM', exit);
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (_str: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (key?.name === 'q' || key?.name === 'escape' || (key?.ctrl && key.name === 'c')) exit();
    });
  }

  out.write(term.altOn + term.hideCursor);
  const tick = async (): Promise<void> => {
    await refresh();
    if (stopped) return;
    const frame = render(state, opts, termWidth(), termHeight()).map((l) => `${l}\x1b[K`);
    out.write(term.home + frame.join('\n') + term.clearDown);
    timer = setTimeout(() => void tick(), opts.intervalMs);
  };
  await tick();
}
