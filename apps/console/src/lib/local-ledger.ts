import { computeLedgerHash, LEDGER_GENESIS_HASH, randomUuid } from '@aegisgate/shared';
import type { LedgerEntryView } from './types';

const MAX_ENTRIES_PER_PROJECT = 500;

export interface LocalAccount {
  id: string;
  code: string;
  balance: number;
}

/**
 * In-browser double-entry journal. Same convention and the same isomorphic SHA-256
 * (`computeLedgerHash` from @aegisgate/shared) as the gateway and Postgres ledger: DEBIT subtracts
 * from the account balance, CREDIT adds, and each project has its own hash chain.
 */
export class LocalLedger {
  private readonly journals = new Map<string, LedgerEntryView[]>();

  entries(projectId: string): LedgerEntryView[] {
    return this.journals.get(projectId) ?? [];
  }

  /** Drops a project's journal (mirrors the Postgres cascade) and returns the removed entries. */
  removeProject(projectId: string): LedgerEntryView[] {
    const journal = this.journals.get(projectId) ?? [];
    this.journals.delete(projectId);
    return journal;
  }

  post(projectId: string, debit: LocalAccount, credit: LocalAccount, amountCredits: number, description: string): string {
    const journal = this.journals.get(projectId) ?? [];
    this.journals.set(projectId, journal);
    const last = journal[journal.length - 1];
    const prevHash = last?.entryHash ?? LEDGER_GENESIS_HASH;
    const debitTs = new Date(Math.max(Date.now(), (last ? Date.parse(last.createdAt) : 0) + 1));
    const creditTs = new Date(debitTs.getTime() + 1);
    const transactionId = randomUuid();

    debit.balance -= amountCredits;
    credit.balance += amountCredits;

    const debitHash = computeLedgerHash(prevHash, transactionId, debit.id, 'DEBIT', amountCredits, debitTs.toISOString());
    const creditHash = computeLedgerHash(debitHash, transactionId, credit.id, 'CREDIT', amountCredits, creditTs.toISOString());

    journal.push(
      {
        id: randomUuid(),
        transactionId,
        projectId,
        accountId: debit.id,
        direction: 'DEBIT',
        amountCredits,
        balanceAfter: debit.balance,
        description,
        prevHash,
        entryHash: debitHash,
        createdAt: debitTs.toISOString(),
      },
      {
        id: randomUuid(),
        transactionId,
        projectId,
        accountId: credit.id,
        direction: 'CREDIT',
        amountCredits,
        balanceAfter: credit.balance,
        description,
        prevHash: debitHash,
        entryHash: creditHash,
        createdAt: creditTs.toISOString(),
      },
    );
    if (journal.length > MAX_ENTRIES_PER_PROJECT) journal.splice(0, journal.length - MAX_ENTRIES_PER_PROJECT);
    return transactionId;
  }
}
