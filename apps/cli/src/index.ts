#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { c } from './ansi';
import { runBench } from './commands/bench';
import { runSim } from './commands/sim';
import { runTop } from './commands/top';

const DEFAULT_GATEWAY = process.env.AEGIS_GATEWAY_URL ?? 'http://localhost:4000';
const DEFAULT_KEY = 'ag_live_happyshark_demo_key_2026';

const HELP = `
${c.bold(c.cyan('aegis'))} · AegisGate terminal toolkit

${c.bold('Usage')}
  aegis sim    [--limit 100] [--window 60] [--burst 120] [--requests 200]
  aegis bench  [--key <apiKey>] [--route /api/room/join] [--method POST]
               [--requests 80] [--concurrency 15] [--ip 203.0.113.7]
  aegis top    [--once] [--interval 1500]

${c.bold('Common')}
  --url <gatewayUrl>   default ${DEFAULT_GATEWAY} (or AEGIS_GATEWAY_URL)
  -h, --help           show this help
`;

class UsageError extends Error {}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer (got '${value}')`);
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const { values } = parseArgs({
    args: command === 'help' ? argv : argv.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      url: { type: 'string' },
      key: { type: 'string' },
      route: { type: 'string' },
      method: { type: 'string' },
      ip: { type: 'string' },
      requests: { type: 'string' },
      concurrency: { type: 'string' },
      limit: { type: 'string' },
      window: { type: 'string' },
      burst: { type: 'string' },
      interval: { type: 'string' },
      once: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const gatewayUrl = (values.url ?? DEFAULT_GATEWAY).replace(/\/+$/, '');

  switch (command) {
    case 'sim':
      return runSim({
        gatewayUrl,
        limitCount: positiveInt(values.limit, 100, 'limit'),
        windowSec: positiveInt(values.window, 60, 'window'),
        burstCapacity: positiveInt(values.burst, 120, 'burst'),
        totalRequests: positiveInt(values.requests, 200, 'requests'),
      });
    case 'bench':
      return runBench({
        gatewayUrl,
        apiKey: values.key ?? DEFAULT_KEY,
        route: values.route ?? '/api/room/join',
        method: (values.method ?? 'POST').toUpperCase(),
        clientIp: values.ip ?? '203.0.113.7',
        requests: positiveInt(values.requests, 80, 'requests'),
        concurrency: positiveInt(values.concurrency, 15, 'concurrency'),
      });
    case 'top':
      return runTop({ gatewayUrl, once: values.once ?? false, intervalMs: positiveInt(values.interval, 1_500, 'interval') });
    default:
      throw new UsageError(`Unknown command '${command}'`);
  }
}

main().catch((err: unknown) => {
  const code = (err as { code?: unknown }).code;
  if (err instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) {
    process.stderr.write(`${c.red('✖')} ${(err as Error).message}\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  console.error(err);
  process.exitCode = 1;
});
