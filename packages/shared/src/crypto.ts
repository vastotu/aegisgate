// Isomorphic crypto: pure TypeScript with no node:crypto import. The same code runs in the
// gateway, db, CLI, SDK and the browser console, so ledger hashes are byte-identical everywhere.

import { ledgerHashPayload } from './contracts';

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4)
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
const utf8 = new TextEncoder();

/** SHA-256 hex digest of a string (UTF-8 encoded, same as node:crypto's default). */
export function sha256Hex(input: string): string {
  const bytes = utf8.encode(input);
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bitLen = bytes.length * 8;
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(paddedLen - 4, bitLen >>> 0);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15]!;
      const w2 = W[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }

    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + W[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// Secure randomness (Web Crypto getRandomValues: global in Node >= 19 and every modern browser)
// ---------------------------------------------------------------------------

interface RandomSource {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

function secureRandomBytes(length: number): Uint8Array {
  const source = (globalThis as unknown as { crypto?: RandomSource }).crypto;
  if (!source || typeof source.getRandomValues !== 'function') {
    // No Math.random fallback: these bytes become API keys.
    throw new Error('Secure randomness unavailable: globalThis.crypto.getRandomValues is required');
  }
  const bytes = new Uint8Array(length);
  source.getRandomValues(bytes);
  return bytes;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** `byteLength` cryptographically random bytes as lowercase hex. */
export function randomHex(byteLength: number): string {
  return toHex(secureRandomBytes(byteLength));
}

/** RFC 4122 version-4 UUID. Unlike crypto.randomUUID, also works in non-secure browser contexts. */
export function randomUuid(): string {
  const b = secureRandomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a raw API key. Only the hash is ever persisted. */
export function hashApiKey(rawKey: string): string {
  return sha256Hex(rawKey);
}

/** Generates a new live API key: `ag_live_<slug>_<32 hex chars>`. */
export function generateApiKey(slug: string): { rawKey: string; keyPrefix: string; keyHash: string } {
  const rawKey = `ag_live_${slug}_${randomHex(16)}`;
  return {
    rawKey,
    keyPrefix: `${rawKey.slice(0, 16)}...`,
    keyHash: hashApiKey(rawKey),
  };
}

// ---------------------------------------------------------------------------
// Ledger hash chain
// ---------------------------------------------------------------------------

/** Chained SHA-256 hash for the append-only ledger journal. */
export function computeLedgerHash(
  prevHash: string,
  txId: string,
  accountId: string,
  direction: string,
  amountCredits: number,
  timestampIso: string,
): string {
  return sha256Hex(ledgerHashPayload(prevHash, txId, accountId, direction, amountCredits, timestampIso));
}

export interface ChainedLedgerEntry {
  id?: string;
  transactionId: string;
  accountId: string;
  direction: string;
  amountCredits: number;
  prevHash: string;
  entryHash: string;
  createdAt: string | Date;
}

export interface LedgerChainVerification {
  verified: boolean;
  /** Entries verified before the first failure (all of them when verified). */
  checked: number;
  brokenEntryId?: string;
}

/**
 * Recomputes every entry hash and checks each prevHash links to the previous entry.
 * Accepts a contiguous window of one project's chain in any order.
 */
export function verifyLedgerChain(entries: readonly ChainedLedgerEntry[]): LedgerChainVerification {
  const iso = (d: string | Date): string => new Date(d).toISOString();
  const ordered = [...entries].sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime());
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i]!;
    const expected = computeLedgerHash(e.prevHash, e.transactionId, e.accountId, e.direction, e.amountCredits, iso(e.createdAt));
    const linked = i === 0 || e.prevHash === ordered[i - 1]!.entryHash;
    if (expected !== e.entryHash || !linked) return { verified: false, checked: i, brokenEntryId: e.id };
  }
  return { verified: true, checked: ordered.length };
}
