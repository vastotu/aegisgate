import { randomUUID } from 'node:crypto';
import { computeLedgerHash } from '@aegisgate/shared';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './client';
import { ledgerAccounts, ledgerEntries, type LedgerEntry } from './schema';

export const GENESIS_HASH = 'GENESIS_00000000000000000000000000000000000000000000000000000000';

export interface DoubleEntryParams {
  projectId: string;
  /** Account whose balance decreases (e.g. prepaid wallet). */
  debitAccountId: string;
  /** Account whose balance increases (e.g. platform revenue). */
  creditAccountId: string;
  amountCredits: number;
  description: string;
}

export interface DoubleEntryResult {
  transactionId: string;
  debitEntry: LedgerEntry;
  creditEntry: LedgerEntry;
}

/**
 * Atomically records a balanced DEBIT/CREDIT pair and moves `amountCredits`
 * from the debit account to the credit account. Entries are hash-chained per project.
 */
export async function recordDoubleEntryTransaction(
  db: Database,
  params: DoubleEntryParams,
): Promise<DoubleEntryResult> {
  const { projectId, debitAccountId, creditAccountId, amountCredits, description } = params;

  if (!Number.isSafeInteger(amountCredits) || amountCredits <= 0) {
    throw new Error(`amountCredits must be a positive integer, got ${amountCredits}`);
  }
  if (debitAccountId === creditAccountId) {
    throw new Error('debitAccountId and creditAccountId must differ');
  }

  return db.transaction(async (tx) => {
    // Serialize writers per project so the hash chain has a single tip.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`);

    // Lock both accounts in a stable order (by id) to prevent deadlocks.
    const locked = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(inArray(ledgerAccounts.id, [debitAccountId, creditAccountId]))
      .orderBy(asc(ledgerAccounts.id))
      .for('update');

    if (locked.length !== 2) {
      throw new Error('Debit or credit ledger account not found');
    }

    const [latest] = await tx
      .select({ entryHash: ledgerEntries.entryHash, createdAt: ledgerEntries.createdAt })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.projectId, projectId))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(1);

    const prevHash = latest?.entryHash ?? GENESIS_HASH;

    // Strictly increasing timestamps keep "latest entry" unambiguous for the next transaction.
    const debitTs = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1));
    const creditTs = new Date(debitTs.getTime() + 1);
    const transactionId = randomUUID();

    const [debitBalance] = await tx
      .update(ledgerAccounts)
      .set({ balanceCredits: sql`${ledgerAccounts.balanceCredits} - ${amountCredits}`, updatedAt: debitTs })
      .where(eq(ledgerAccounts.id, debitAccountId))
      .returning({ balanceCredits: ledgerAccounts.balanceCredits });

    const [creditBalance] = await tx
      .update(ledgerAccounts)
      .set({ balanceCredits: sql`${ledgerAccounts.balanceCredits} + ${amountCredits}`, updatedAt: creditTs })
      .where(eq(ledgerAccounts.id, creditAccountId))
      .returning({ balanceCredits: ledgerAccounts.balanceCredits });

    const debitHash = computeLedgerHash(
      prevHash,
      transactionId,
      debitAccountId,
      'DEBIT',
      amountCredits,
      debitTs.toISOString(),
    );
    const creditHash = computeLedgerHash(
      debitHash,
      transactionId,
      creditAccountId,
      'CREDIT',
      amountCredits,
      creditTs.toISOString(),
    );

    const inserted = await tx
      .insert(ledgerEntries)
      .values([
        {
          transactionId,
          projectId,
          accountId: debitAccountId,
          direction: 'DEBIT',
          amountCredits,
          balanceAfter: debitBalance!.balanceCredits,
          description,
          prevHash,
          entryHash: debitHash,
          createdAt: debitTs,
        },
        {
          transactionId,
          projectId,
          accountId: creditAccountId,
          direction: 'CREDIT',
          amountCredits,
          balanceAfter: creditBalance!.balanceCredits,
          description,
          prevHash: debitHash,
          entryHash: creditHash,
          createdAt: creditTs,
        },
      ])
      .returning();

    const debitEntry = inserted.find((e) => e.direction === 'DEBIT');
    const creditEntry = inserted.find((e) => e.direction === 'CREDIT');
    if (!debitEntry || !creditEntry) {
      throw new Error('Failed to insert balanced ledger entries');
    }

    return { transactionId, debitEntry, creditEntry };
  });
}
