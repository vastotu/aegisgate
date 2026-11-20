import assert from 'node:assert/strict';
import {
  buildLimiterKey,
  computeLedgerHash,
  createMemoryStore,
  findMatchingRule,
  hashApiKey,
  LEDGER_GENESIS_HASH,
  runMemoryAlgorithm,
  SHOWCASE_TENANTS,
  verifyLedgerChain,
  type ChainedLedgerEntry,
  type RateLimitAlgo,
  type UsageLogEvent,
} from '@aegisgate/shared';
import * as offline from '../../apps/gateway/src/showcase-fallback';
import type { Check } from './types';

const limiter = createMemoryStore();
let seq = 0;

/** Runs `count` requests through the offline tenant's real rules + limiter; returns usage events. */
function fire(rawKey: string, route: string, count: number, clientIp: (i: number) => string): UsageLogEvent[] {
  const tenant = offline.getOfflineTenant(hashApiKey(rawKey));
  assert.ok(tenant, 'offline tenant must resolve from its key hash');
  const rule = findMatchingRule(route, 'POST', tenant.rules);
  assert.ok(rule, `no rule for ${route}`);
  const algorithm = rule.algorithm as RateLimitAlgo;
  const now = Date.now();
  const windowMs = rule.windowSec * 1000;
  return Array.from({ length: count }, (_, i) => {
    const identity = { algorithm, keyId: tenant.apiKey.id, routePattern: rule.routePattern, clientIp: clientIp(i) };
    const requestId = `req_${++seq}`;
    const { allowed } = runMemoryAlgorithm(
      limiter,
      algorithm,
      buildLimiterKey(identity, now, windowMs),
      { limitCount: rule.limitCount, windowMs, burstCapacity: rule.burstCapacity, cost: 1, reqId: requestId },
      now,
    );
    return {
      requestId,
      projectId: tenant.project.id,
      apiKeyId: tenant.apiKey.id,
      route,
      method: 'POST',
      statusCode: allowed ? 200 : 429,
      latencyMs: 0.05,
      costCredits: allowed ? rule.costWeightCredits : 0,
      clientIp: identity.clientIp,
      blockedReason: allowed ? null : 'RATE_LIMIT_EXCEEDED',
      timestamp: now,
    };
  });
}

const walletBalance = (slug: string): number => {
  const tenant = offline.getOfflineSnapshot().tenants.find((t) => t.project.slug === slug);
  assert.ok(tenant, `tenant ${slug} missing`);
  return tenant.walletBalanceCredits;
};

/** Hash-chain + double-entry invariants over an arbitrary journal. */
export function assertLedgerInvariants(entries: readonly (ChainedLedgerEntry & { projectId: string })[]): void {
  const projectOf = (e: { projectId: string }): string => e.projectId;
  const sum = (dir: string) => entries.filter((e) => e.direction === dir).reduce((s, e) => s + e.amountCredits, 0);
  assert.ok(entries.length > 0, 'journal is empty');
  assert.equal(sum('DEBIT'), sum('CREDIT'), 'sum(DEBIT) must equal sum(CREDIT)');

  const byTx = new Map<string, ChainedLedgerEntry[]>();
  for (const e of entries) byTx.set(e.transactionId, [...(byTx.get(e.transactionId) ?? []), e]);
  for (const [tx, pair] of byTx) {
    assert.deepEqual(pair.map((e) => e.direction).sort(), ['CREDIT', 'DEBIT'], `tx ${tx} must be one DEBIT + one CREDIT`);
    assert.equal(pair[0]!.amountCredits, pair[1]!.amountCredits, `tx ${tx} must balance`);
    assert.ok(pair[0]!.amountCredits > 0, `tx ${tx} amount must be positive`);
  }

  const byProject = new Map<string, ChainedLedgerEntry[]>();
  for (const e of entries) byProject.set(projectOf(e), [...(byProject.get(projectOf(e)) ?? []), e]);
  for (const [projectId, journal] of byProject) {
    const chain = [...journal].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let prev = LEDGER_GENESIS_HASH;
    for (const e of chain) {
      assert.equal(e.prevHash, prev, `broken prevHash link in project ${projectId}`);
      const recomputed = computeLedgerHash(e.prevHash, e.transactionId, e.accountId, e.direction, e.amountCredits, new Date(e.createdAt).toISOString());
      assert.equal(recomputed, e.entryHash, `entryHash mismatch in project ${projectId}`);
      prev = e.entryHash;
    }
    assert.equal(verifyLedgerChain(chain).verified, true);
  }
}

export const checks: Check[] = [
  {
    name: 'Offline showcase: allowed requests are rate-limited by real rules and settled as DEBIT WALLET / CREDIT PLATFORM:REVENUE',
    run: () => {
      const happyshark = SHOWCASE_TENANTS.find((t) => t.slug === 'happyshark')!;
      const before = walletBalance('happyshark');
      const players = fire(happyshark.demoApiKey, '/api/room/join', 25, (i) => `198.51.100.${10 + i}`);
      const flood = fire(happyshark.demoApiKey, '/api/room/join', 40, () => '203.0.113.66');
      assert.equal(players.filter((e) => e.statusCode === 200).length, 25);
      assert.equal(flood.filter((e) => e.statusCode === 200).length, 30, 'token bucket burst capacity is 30');

      const settled = offline.settleOfflineUsage([...players, ...flood]);
      const expected = (25 + 30) * 5;
      assert.equal([...settled.values()].reduce((s, c) => s + c, 0), expected);
      assert.equal(walletBalance('happyshark'), before - expected);
    },
  },
  {
    name: "Offline showcase: onboard 4th project 'ntu-course-helper', upsert a rule, top up and settle usage",
    run: () => {
      const created = offline.createOfflineProject({
        name: 'NTU Course Helper',
        slug: 'ntu-course-helper',
        upstreamUrl: 'https://api.example.com',
        monthlyBudgetCredits: 100_000,
      });
      assert.match(created.apiKey, /^ag_live_ntu-course-helper_[0-9a-f]{32}$/);
      assert.throws(() => offline.createOfflineProject({ name: 'dup', slug: 'ntu-course-helper', upstreamUrl: 'https://x.dev', monthlyBudgetCredits: 1 }), offline.OfflineConflictError);

      const rule = { projectSlug: 'ntu-course-helper', routePattern: '/api/export-pdf', httpMethod: 'ALL', algorithm: 'token_bucket' as const, windowSec: 60, costWeightCredits: 50, priority: 10 };
      assert.equal(offline.upsertOfflineRule({ ...rule, limitCount: 10, burstCapacity: 10 }).status, 'created');
      assert.equal(offline.upsertOfflineRule({ ...rule, limitCount: 20, burstCapacity: 12 }).status, 'updated');

      assert.equal(offline.topUpOfflineWallet({ projectSlug: 'ntu-course-helper' }, 25_000)?.walletBalanceCredits, 125_000);
      const events = fire(created.apiKey, '/api/export-pdf', 15, () => '192.0.2.7');
      assert.equal(events.filter((e) => e.statusCode === 200).length, 12, 'burst capacity 12 after update');
      offline.settleOfflineUsage(events);
      assert.equal(walletBalance('ntu-course-helper'), 125_000 - 12 * 50);
    },
  },
  {
    name: 'Offline CRUD symmetry: delete a rule (last * protected), delete a custom project, showcase tenants locked',
    run: () => {
      const created = offline.createOfflineProject({ name: 'Temp Project', slug: 'temp-delete-me', upstreamUrl: 'https://api.example.com', monthlyBudgetCredits: 5_000 });
      const projectId = created.project.id;
      const wildcard = created.rateLimitRules[0]!;
      const added = offline.upsertOfflineRule({ projectId, routePattern: '/api/tmp', httpMethod: 'ALL', algorithm: 'token_bucket', limitCount: 5, windowSec: 60, burstCapacity: 5, costWeightCredits: 2, priority: 10 });
      assert.ok('rule' in added && added.status === 'created');
      assert.equal(offline.deleteOfflineRule(added.rule.id), 'deleted');
      assert.equal(offline.deleteOfflineRule(added.rule.id), 'not_found');
      assert.equal(offline.deleteOfflineRule(wildcard.id), 'last_wildcard');

      // Earn some revenue first so deletion has platform-account effects to reverse.
      offline.settleOfflineUsage(fire(created.apiKey, '/anything', 3, () => '192.0.2.9'));

      const showcase = offline.getOfflineTenant(hashApiKey(SHOWCASE_TENANTS[0]!.demoApiKey))!;
      assert.equal(offline.deleteOfflineProject(showcase.project.id), 'protected');
      assert.equal(offline.deleteOfflineProject(projectId), 'deleted');
      assert.equal(offline.getOfflineTenant(hashApiKey(created.apiKey)), null, 'deleted key must stop resolving');
      assert.ok(!offline.getOfflineSnapshot().tenants.some((t) => t.project.id === projectId));
      assert.equal(offline.deleteOfflineProject(projectId), 'not_found');
    },
  },
  {
    name: 'Ledger invariants: sum(DEBIT) == sum(CREDIT), sum(balances) == 0, balances == journal, SHA-256 chain intact',
    run: () => {
      const { accounts, entries } = offline.getOfflineLedgerState();
      assertLedgerInvariants(entries);
      assert.equal(accounts.reduce((s, a) => s + a.balanceCredits, 0), 0, 'closed system: balances must sum to zero');
      for (const account of accounts) {
        const net = entries
          .filter((e) => e.accountId === account.id)
          .reduce((s, e) => s + (e.direction === 'CREDIT' ? e.amountCredits : -e.amountCredits), 0);
        assert.equal(account.balanceCredits, net, `${account.accountCode} balance must equal its journal`);
      }
    },
  },
  {
    name: 'Tamper detection: editing one historical amount breaks the hash chain',
    run: () => {
      const { entries } = offline.getOfflineLedgerState();
      const journal = entries.filter((e) => e.projectId === entries[0]!.projectId);
      assert.equal(verifyLedgerChain(journal).verified, true);
      const tampered = journal.map((e, i) => (i === 0 ? { ...e, amountCredits: e.amountCredits + 1 } : e));
      assert.equal(verifyLedgerChain(tampered).verified, false);
    },
  },
];
