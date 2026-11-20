import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeLedgerHash, generateApiKey, hashApiKey, randomHex, randomUuid, sha256Hex } from '@aegisgate/shared';
import type { Check } from './types';

const nodeSha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const checks: Check[] = [
  {
    name: 'Isomorphic SHA-256 matches FIPS 180-4 test vectors',
    run: () => {
      assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      assert.equal(
        sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      );
    },
  },
  {
    name: 'Isomorphic SHA-256 is byte-identical to node:crypto (Postgres/Gateway/CLI/Browser parity)',
    run: () => {
      const inputs = ['🦈 HappyShark.io – über café ✓', 'GENESIS|tx|acct|DEBIT|500000|2026-01-01T00:00:00.000Z'];
      for (let len = 0; len <= 200; len++) inputs.push('x'.repeat(len)); // covers every padding boundary (55/56/63/64/119/120)
      for (let i = 0; i < 50; i++) inputs.push(randomHex(1 + i * 7));
      for (const input of inputs) assert.equal(sha256Hex(input), nodeSha256(input), `mismatch for input of length ${input.length}`);
    },
  },
  {
    name: "generateApiKey('happyshark') → ag_live_ key, 16-char prefix, 64-hex SHA-256 keyHash, hashApiKey round-trip",
    run: () => {
      const { rawKey, keyPrefix, keyHash } = generateApiKey('happyshark');
      assert.match(rawKey, /^ag_live_happyshark_[0-9a-f]{32}$/);
      assert.equal(keyPrefix, `${rawKey.slice(0, 16)}...`);
      assert.match(keyHash, /^[0-9a-f]{64}$/);
      assert.equal(hashApiKey(rawKey), keyHash);
      assert.equal(keyHash, nodeSha256(rawKey));
      assert.notEqual(generateApiKey('happyshark').rawKey, rawKey, 'keys must be random');
      assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    },
  },
  {
    name: 'computeLedgerHash is deterministic and changes when any field changes',
    run: () => {
      const args = ['prev', 'tx-1', 'acct-1', 'DEBIT', 500, '2026-01-01T00:00:00.000Z'] as const;
      const base = computeLedgerHash(...args);
      assert.equal(computeLedgerHash(...args), base);
      assert.equal(base, nodeSha256(args.join('|')));
      assert.notEqual(computeLedgerHash('prev', 'tx-1', 'acct-1', 'DEBIT', 501, args[5]), base);
      assert.notEqual(computeLedgerHash('prev', 'tx-1', 'acct-1', 'CREDIT', 500, args[5]), base);
    },
  },
];
