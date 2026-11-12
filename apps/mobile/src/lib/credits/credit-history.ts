import type { inferRouterOutputs, MobileRouter } from '@kilocode/trpc/mobile';

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
  switch (creditSource) {
    case 'apple': {
      return 'app_store';
    }
    case 'google_play': {
      return 'google_play';
    }
    case 'stripe':
    // A legacy top-up recorded before the column existed has no channel, and
    // it is still a card purchase: the receipt lookup decides whether a
    // receipt exists at all.
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
    };

function timestampOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The single chronological list the screen renders: purchases (which carry a
 * receipt) and the ledger's grants, expiries, and deductions.
 *
 * Purchases arrive paged and the ledger does not, so a ledger row that is newer
 * than the oldest loaded purchase still sorts above it; the two sources cannot
 * disagree on a timestamp because both are stored on the same credit row.
 */
export function buildCreditHistoryItems(
  purchases: readonly CreditPurchaseEntry[],
  deductions: readonly CreditDeduction[]
): CreditHistoryItem[] {
  const items: CreditHistoryItem[] = [
    ...purchases.map((entry): CreditHistoryItem => ({
      kind: 'purchase',
      key: `purchase:${entry.id}`,
      entry,
      sortDate: entry.date,
    })),
    ...deductions.map((deduction): CreditHistoryItem => ({
      kind: 'ledger',
      key: `ledger:${deduction.id}`,
      deduction,
      sortDate: deduction.purchase?.date ?? deduction.date,
    })),
  ];

  return items.sort((a, b) => {
    const byDate = timestampOf(b.sortDate) - timestampOf(a.sortDate);
    if (byDate !== 0) {
      return byDate;
    }
    // A deterministic order for two rows that share a timestamp, so a refetch
    // cannot reshuffle them under the reader.
    return a.key.localeCompare(b.key);
  });
}
