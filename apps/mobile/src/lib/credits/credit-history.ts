import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { parseTimestamp } from '@/lib/utils';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** One completed paid credit purchase, as the purchase history lists it. */
export type CreditPurchaseEntry =
  RouterOutputs['user']['getCreditPurchaseHistory']['entries'][number];

/** One negative credit ledger row: usage, an expiry, or an adjustment. */
export type CreditDeduction = RouterOutputs['user']['getCreditBlocks']['deductions'][number];

/**
 * Where a paid credit grant came from. The web credits page reads the same
 * column to label a grant, and the purchase row needs it to decide between a
 * Stripe receipt and the store that sold the pack.
 */
export type CreditPurchaseChannel = 'card' | 'app_store' | 'google_play' | 'other';

export function creditPurchaseChannel(creditSource: string | null): CreditPurchaseChannel {
  // A legacy top-up recorded before the column existed has no channel, and it
  // is still a card purchase: the receipt lookup decides whether a receipt
  // exists at all.
  switch (creditSource) {
    case 'apple': {
      return 'app_store';
    }
    case 'google_play': {
      return 'google_play';
    }
    case 'stripe':
    case null: {
      return 'card';
    }
    default: {
      return 'other';
    }
  }
}

/** The grant line's type on a ledger row, keyed for the row to localize. */
export type CreditGrantKind = 'purchase' | 'pass' | 'grant';

/**
 * Mirrors the web credits page: a recorded channel decides first, and only a
 * grant with no channel falls back to its free flag.
 */
export function creditGrantKind(grant: {
  creditSource: string | null;
  isFree: boolean;
}): CreditGrantKind {
  switch (grant.creditSource) {
    case 'stripe':
    case 'google_play':
    case 'apple': {
      return 'purchase';
    }
    case 'pass': {
      return 'pass';
    }
    case 'admin': {
      return 'grant';
    }
    case null: {
      return grant.isFree ? 'grant' : 'purchase';
    }
    default: {
      return grant.isFree ? 'grant' : 'purchase';
    }
  }
}

/**
 * One row of the personal credit history.
 *
 * `sortDate` is the event's own date: an expiry row reads under the grant it
 * closed, the same way the web page pairs them, so both land together instead
 * of being separated by everything that happened in between.
 */
export type CreditHistoryItem =
  | {
      readonly kind: 'purchase';
      readonly key: string;
      readonly entry: CreditPurchaseEntry;
      readonly sortDate: string;
    }
  | {
      readonly kind: 'ledger';
      readonly key: string;
      readonly deduction: CreditDeduction;
      readonly sortDate: string;
      /**
       * True when the paid grant this row belongs to is already on screen as
       * its own purchase row. The row then prints only the event it records
       * (an expiry) instead of that grant a second time.
       */
      readonly grantListed: boolean;
    };

/**
 * Rank of one row's date, newest first.
 *
 * The ledger hands back the raw `credit_transactions.created_at` column
 * (`2026-03-16 15:21:40.957+00`), which Hermes' `Date.parse` rejects and the
 * shared parser normalizes; a purchase arrives as ISO already. A row whose time
 * still does not parse sorts below every dated row rather than claiming a real
 * instant, so one broken record cannot reorder the rest.
 */
function sortTimeOf(value: string): number {
  const at = parseTimestamp(value).getTime();
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * The single chronological list the screen renders: purchases (which carry a
 * receipt) and the ledger's grants, expiries, and deductions.
 *
 * Purchases arrive paged and the ledger does not, so a ledger row that is newer
 * than the oldest loaded purchase still sorts above it; the two sources cannot
 * disagree on a timestamp because both are stored on the same credit row. A
 * ledger row whose grant already has its purchase row is flagged so the row
 * prints the expiry alone, and the purchase stays one row.
 */
export function buildCreditHistoryItems(
  purchases: readonly CreditPurchaseEntry[],
  deductions: readonly CreditDeduction[]
): CreditHistoryItem[] {
  // The two reads overlap: an expiry row names the grant it closed, and a paid
  // grant is also a purchase row with its receipt. Only the purchase pages the
  // screen holds can be duplicated, so the loaded ids decide.
  const listedPurchaseIds = new Set(purchases.map(entry => entry.id));
  const items: CreditHistoryItem[] = [
    ...purchases.map((entry): CreditHistoryItem => ({
      kind: 'purchase',
      key: `purchase:${entry.id}`,
      entry,
      sortDate: entry.date,
    })),
    ...deductions.map((deduction): CreditHistoryItem => {
      const grant = deduction.purchase;
      return {
        kind: 'ledger',
        key: `ledger:${deduction.id}`,
        deduction,
        sortDate: grant?.date ?? deduction.date,
        grantListed: grant != null && listedPurchaseIds.has(grant.id),
      };
    }),
  ];

  return items.sort((a, b) => {
    const atA = sortTimeOf(a.sortDate);
    const atB = sortTimeOf(b.sortDate);
    if (atA !== atB) {
      return atB - atA;
    }
    // A deterministic order for two rows that share a timestamp (or whose time
    // does not parse), so a refetch cannot reshuffle them under the reader.
    return a.key.localeCompare(b.key);
  });
}
