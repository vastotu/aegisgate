// In-process end-to-end verification suite (no servers, no network, no Docker).
// Usage: npx pnpm@9.12.0 test

import type { Check } from './checks/types';

async function main(): Promise<void> {
  const startedAt = performance.now();

  // The gateway's offline store imports @aegisgate/db, which builds a lazy Postgres client.
  // Point it at an unroutable URL so the suite is hermetic: no query is ever issued.
  process.env.DATABASE_URL ??= 'postgresql://offline:offline@127.0.0.1:1/aegisgate_verify';

  const groups: [string, Check[]][] = [
    ['Crypto & API keys', (await import('./checks/crypto')).checks],
    ['Rate limiter & boundary burst', (await import('./checks/ratelimit')).checks],
    ['Offline showcase & double-entry ledger', (await import('./checks/ledger')).checks],
    ['Browser sandbox parity', (await import('./checks/sandbox')).checks],
  ];

  let passed = 0;
  let failed = 0;
  for (const [title, checks] of groups) {
    console.log(`\n▸ ${title}`);
    for (const check of checks) {
      try {
        await check.run();
        passed++;
        console.log(`  [PASS] ${check.name}`);
      } catch (err) {
        failed++;
        console.log(`  [FAIL] ${check.name}\n         ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const elapsed = performance.now() - startedAt;
  console.log(`\n${failed === 0 ? '✔' : '✖'} ${passed}/${passed + failed} checks passed in ${elapsed.toFixed(0)}ms`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
