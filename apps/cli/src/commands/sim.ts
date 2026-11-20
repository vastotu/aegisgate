import {
  BOUNDARY_SPREAD_MS,
  simulateBurst,
  type RateLimitAlgo,
  type SimulateBurstRequest,
  type SimulationResult,
} from '@aegisgate/shared';
import { bar, box, c, fit, fmt, padLeft, sparkline, termWidth } from '../ansi';
import { requestJson } from '../http';

const ALGORITHMS: { id: RateLimitAlgo; label: string }[] = [
  { id: 'fixed_window', label: 'Fixed Window' },
  { id: 'sliding_window', label: 'Sliding Window' },
  { id: 'token_bucket', label: 'Token Bucket' },
];

export interface SimOptions {
  gatewayUrl: string;
  limitCount: number;
  windowSec: number;
  burstCapacity: number;
  totalRequests: number;
}

type Engine = 'gateway' | 'local';

const isSimulationResult = (v: unknown): v is SimulationResult =>
  typeof v === 'object' && v !== null && 'summary' in v && 'timeline' in v;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function runAll(opts: SimOptions): Promise<{ engine: Engine; results: SimulationResult[] }> {
  let engine: Engine = 'gateway';
  const results: SimulationResult[] = [];
  for (const algo of ALGORITHMS) {
    const req: SimulateBurstRequest = {
      algorithm: algo.id,
      limitCount: opts.limitCount,
      windowSec: opts.windowSec,
      burstCapacity: opts.burstCapacity,
      totalRequests: opts.totalRequests,
      scenario: 'boundary_burst',
    };
    let result: SimulationResult | null = null;
    if (engine === 'gateway') {
      try {
        const res = await requestJson<unknown>(`${opts.gatewayUrl}/v1/simulate-burst`, { method: 'POST', body: req, timeoutMs: 1_000 });
        if (res.status === 200 && isSimulationResult(res.body)) result = res.body;
      } catch {
        // Gateway offline: run the identical algorithms in-process.
      }
    }
    if (!result) {
      engine = 'local';
      result = simulateBurst(req);
    }
    results.push(result);
  }
  return { engine, results };
}

function classify(peak: number, limit: number, burst: number): { text: string; paint: (s: string) => string } {
  if (peak > Math.max(limit, burst)) {
    return { text: `✖ BOUNDARY LEAK (${fmt.pct((peak / limit) * 100)} of limit)`, paint: c.red };
  }
  if (peak <= limit) return { text: '✔ STRICT CAP', paint: c.green };
  return { text: `✔ BURST-BOUNDED (≤ burst ${burst})`, paint: c.cyan };
}

export async function runSim(opts: SimOptions): Promise<void> {
  const { engine, results } = await runAll(opts);
  const width = Math.min(termWidth(), 110);
  const windowMs = opts.windowSec * 1000;
  const labelWidth = 16;
  const out: string[] = [];

  out.push(
    ...box('AegisGate · Boundary-Burst Attack Simulation', [
      `${c.bold('Attack')}  ${opts.totalRequests} requests fired at t=${seconds(windowMs - BOUNDARY_SPREAD_MS)} → ${seconds(windowMs + BOUNDARY_SPREAD_MS)}, straddling the ${opts.windowSec}s window boundary`,
      `${c.bold('Policy')}  limit ${opts.limitCount} req / ${opts.windowSec}s · burst capacity ${opts.burstCapacity}`,
      `${c.bold('Engine')}  ${
        engine === 'gateway'
          ? c.green(`gateway ${opts.gatewayUrl}/v1/simulate-burst`)
          : c.yellow('local in-process (gateway offline) · same algorithms as the gateway L1 limiter')
      }`,
    ], width),
  );

  const verdicts = results.map((r) => classify(r.summary.peakBurstRate, opts.limitCount, opts.burstCapacity));

  const header =
    fit(c.bold('ALGORITHM'), labelWidth) +
    padLeft(c.bold('ALLOWED'), 9) +
    padLeft(c.bold('BLOCKED'), 9) +
    padLeft(c.bold(`PEAK/${opts.windowSec}s`), 10) +
    padLeft(c.bold('vs LIMIT'), 10) +
    `  ${c.bold('VERDICT')}`;
  const rows = results.map((r, i) => {
    const v = verdicts[i]!;
    return (
      fit(ALGORITHMS[i]!.label, labelWidth) +
      padLeft(c.green(fmt.int(r.summary.allowed)), 9) +
      padLeft(c.red(fmt.int(r.summary.blocked)), 9) +
      padLeft(v.paint(fmt.int(r.summary.peakBurstRate)), 10) +
      padLeft(v.paint(fmt.pct((r.summary.peakBurstRate / opts.limitCount) * 100)), 10) +
      `  ${v.paint(v.text)}`
    );
  });
  out.push(...box('Results', [header, ...rows], width));

  const maxPeak = Math.max(opts.totalRequests, ...results.map((r) => r.summary.peakBurstRate));
  const barWidth = width - 4 - labelWidth - 6;
  const bars = results.map(
    (r, i) => fit(ALGORITHMS[i]!.label, labelWidth) + bar(r.summary.peakBurstRate, maxPeak, barWidth, verdicts[i]!.paint) + padLeft(r.summary.peakBurstRate, 6),
  );
  const limitCol = Math.max(0, Math.round((opts.limitCount / maxPeak) * barWidth) - 1);
  bars.push(' '.repeat(labelWidth + limitCol) + c.yellow(`▲ limit ${opts.limitCount}`));
  out.push(...box(`Peak admitted requests in any rolling ${opts.windowSec}s window`, bars, width));

  const timeline = results[0]!.timeline;
  const tickMs = timeline.length > 1 ? timeline[1]!.tickMs - timeline[0]!.tickMs : 0;
  const maxTick = Math.max(1, ...results.flatMap((r) => r.timeline.map((t) => t.allowed)));
  const sparkRows = results.map((r, i) => {
    const spark = sparkline(r.timeline.map((t) => t.allowed), maxTick).split('').map((ch) => ch + ch).join('');
    return fit(ALGORITHMS[i]!.label, labelWidth) + verdicts[i]!.paint(spark);
  });
  const half = timeline.length;
  sparkRows.push(
    ' '.repeat(labelWidth) +
      c.gray(fit(seconds(timeline[0]!.tickMs), half)) +
      c.yellow('│') +
      c.gray(` ${seconds(windowMs)} boundary → ${seconds(windowMs + BOUNDARY_SPREAD_MS)}`),
  );
  out.push(...box(`Admitted requests per ${tickMs}ms tick`, sparkRows, width));

  const fixed = results[0]!.summary;
  out.push(
    '',
    `${c.red('▸')} ${c.bold('Fixed Window')} admitted ${c.red(fmt.int(fixed.peakBurstRate))} requests within ${BOUNDARY_SPREAD_MS * 2}ms: its counter resets at t=${opts.windowSec}s, so an attacker gets ${fmt.pct((fixed.peakBurstRate / opts.limitCount) * 100)} of the limit.`,
    `${c.green('▸')} ${c.bold('Sliding Window')} counts the trailing ${opts.windowSec}s, so the cap holds at ${fmt.int(results[1]!.summary.peakBurstRate)} across the boundary.`,
    `${c.cyan('▸')} ${c.bold('Token Bucket')} admits at most its burst capacity (${fmt.int(results[2]!.summary.peakBurstRate)}), then refills at ${opts.limitCount}/${opts.windowSec}s.`,
    '',
  );

  process.stdout.write(`${out.join('\n')}\n`);
}
