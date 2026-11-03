export type CreditDeductionKind = 'deduction' | 'adjustment' | 'balance_neutral';

export type CreditDeductionRow = {
  id: string;
  date: string;
  description: string;
  amount_mUsd: number;
  kind: CreditDeductionKind;
  /** The grant this deduction closed, present for an expiry row. */
  purchase: {
    id: string;
    date: string;
    description: string;
    amount_mUsd: number;
    is_free: boolean;
    credit_source: string | null;
  } | null;
};

export type DeductionGroup = {
  key: string;
  main: { date: string; description: string; type: string; amount_mUsd: number };
  child?: { description: string; type: string; amount_mUsd: number };
};

export function deductionKindLabel(kind: CreditDeductionKind): string {
  switch (kind) {
    case 'balance_neutral':
      return 'Balance neutral';
    case 'adjustment':
      return 'Adjustment';
    case 'deduction':
      return 'Deduction';
  }
}

/**
 * The type shown on the grant line. `is_free` alone is not enough: admin and
 * Pass grants carry `is_free: false`, so the recorded source decides first, and
 * only a legacy paid grant with no source falls back to its free flag.
 */
export function grantTypeLabel(purchase: {
  is_free: boolean;
  credit_source: string | null;
}): string {
  switch (purchase.credit_source) {
    case 'stripe':
    case 'google_play':
    case 'apple':
      return 'Purchase';
    case 'pass':
      return 'Kilo Pass';
    case 'admin':
      return 'Credit grant';
    default:
      return purchase.is_free ? 'Credit grant' : 'Purchase';
  }
}

/**
 * One table group per credit event: a purchase with the expiry that closed it.
 * The purchase is the main row, so its date leads the pair and the expiry reads
 * as the second ledger line of the same event.
 */
export function buildDeductionGroups(deductions: CreditDeductionRow[]): DeductionGroup[] {
  return deductions
    .map(deduction => {
      if (!deduction.purchase) {
        return {
          key: deduction.id,
          main: {
            date: deduction.date,
            description: deduction.description,
            type: deductionKindLabel(deduction.kind),
            amount_mUsd: deduction.amount_mUsd,
          },
        };
      }
      return {
        key: deduction.id,
        main: {
          date: deduction.purchase.date,
          description: deduction.purchase.description,
          type: grantTypeLabel(deduction.purchase),
          amount_mUsd: deduction.purchase.amount_mUsd,
        },
        child: {
          description: deduction.description,
          type: deductionKindLabel(deduction.kind),
          amount_mUsd: deduction.amount_mUsd,
        },
      };
    })
    .sort((a, b) => new Date(b.main.date).getTime() - new Date(a.main.date).getTime());
}
