import assert from 'node:assert/strict';
import { SHOWCASE_TENANTS } from '@aegisgate/shared';
import { LocalEngine } from '../../apps/console/src/lib/local-engine';
import { assertLedgerInvariants } from './ledger';
import type { Check } from './types';

export const checks: Check[] = [
  {
    name: 'Console in-browser engine: same decisions, write-behind settlement and verifiable hash chain as the gateway',
    run: async () => {
      const engine = new LocalEngine();
      const key = SHOWCASE_TENANTS.find((t) => t.slug === 'happyshark')!.demoApiKey;

      const outcomes = await Promise.all(
        Array.from({ length: 40 }, () => engine.check({ apiKey: key, route: '/api/room/join', method: 'POST', clientIp: '203.0.113.66' })),
      );
      assert.equal(outcomes.filter((o) => o.httpStatus === 200).length, 30);
      assert.equal(outcomes.filter((o) => o.httpStatus === 429).length, 10);
      assert.equal(outcomes[0]!.headers['x-aegis-billing-cost-credits'], '5');
      assert.equal((await engine.check({ apiKey: 'ag_live_nope', route: '/', method: 'GET', clientIp: '1.1.1.1' })).httpStatus, 401);

      assert.equal((await engine.flush()).settledCredits, 150);
      const created = await engine.createProject({ name: 'NTU Course Helper', slug: 'ntu-course-helper', upstreamUrl: 'https://api.example.com', monthlyBudgetCredits: 100_000 });
      assert.equal(await engine.topUp(created.project.slug, 25_000), 125_000);

      const overview = await engine.overview();
      assert.equal(overview.dataSource, 'browser-sandbox');
      assert.equal(overview.projects.length, 4);
      const entries = overview.projects.flatMap((p) => p.recentLedgerEntries);
      assertLedgerInvariants(entries);
      const shark = overview.projects.find((p) => p.slug === 'happyshark')!;
      assert.equal(shark.walletBalanceCredits, 500_000 - 150);
    },
  },
];
