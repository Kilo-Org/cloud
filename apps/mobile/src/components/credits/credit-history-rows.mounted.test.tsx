/* eslint-disable max-lines -- the three rows of one module keep their contract in one mounted suite: the shared fixtures, the renderer, and both catalog languages only read correctly together */
import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import {
  type CreditDeduction,
  type CreditGrant,
  type CreditPurchaseEntry,
} from '@/lib/credits/credit-history';

import { GrantHistoryRow, LedgerHistoryRow, PurchaseHistoryRow } from './credit-history-rows';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ExternalLink: 'ExternalLink' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#71717a' }),
}));

function entry(overrides: Partial<CreditPurchaseEntry> = {}): CreditPurchaseEntry {
  return {
    id: 'purchase-1',
    date: '2026-11-12T10:00:00.000Z',
    kind: 'purchase',
    amount_mUsd: 10_000_000,
    expiryDate: '2027-11-12T00:00:00.000Z',
    creditSource: 'google_play',
    ...overrides,
  };
}

async function render(element: ReactElement) {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(element);
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function renderRow(purchase: CreditPurchaseEntry) {
  return render(
    createElement(PurchaseHistoryRow, {
      entry: purchase,
      isOpeningReceipt: false,
      last: false,
      onOpenReceipt: () => undefined,
    })
  );
}

function renderGrantRow(grantRow: CreditGrant) {
  return render(createElement(GrantHistoryRow, { grant: grantRow, last: false }));
}

function grant(overrides: Partial<CreditGrant> = {}): CreditGrant {
  return {
    id: 'grant-1',
    date: '2026-11-12T10:00:00.000Z',
    amount_mUsd: 12_500_000,
    kind: 'referral',
    expiryDate: null,
    ...overrides,
  };
}

function deduction(overrides: Partial<CreditDeduction> = {}): CreditDeduction {
  return {
    id: 'deduction-1',
    date: '2026-11-12T10:00:00.000Z',
    description: 'Credit expired',
    amount_mUsd: -10_000_000,
    kind: 'deduction',
    expiry: null,
    reason: null,
    planName: null,
    purchase: null,
    ...overrides,
  };
}

type DeductionGrant = NonNullable<CreditDeduction['purchase']>;

/** The grant an expiry deduction closed, stored with the ledger's own wording. */
function deductionGrant(overrides: Partial<DeductionGrant> = {}): DeductionGrant {
  return {
    id: 'grant-1',
    date: '2026-08-01T10:00:00.000Z',
    description: 'influencer-bonus',
    amount_mUsd: 10_000_000,
    is_free: true,
    credit_source: null,
    kind: 'influencer',
    ...overrides,
  };
}

function renderLedgerRow(deductionRow: CreditDeduction, grantListed = false) {
  return render(
    createElement(LedgerHistoryRow, { deduction: deductionRow, grantListed, last: false })
  );
}

/** Every string the row paints, so a line the row drops is visible to a test. */
function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  const collected: string[] = [];
  const walk = (instance: TestRenderer.ReactTestInstance): void => {
    for (const child of instance.children) {
      if (typeof child === 'string') {
        collected.push(child);
      } else if (typeof child !== 'number') {
        walk(child);
      }
    }
  };
  walk(renderer.root);
  return collected;
}

// The zone marker carries a bidi isolate and the date a no-break space; these
// assertions are about the sentence, not that carriage.
function readable(text: string): string {
  return text.replaceAll(/[\u2066\u2068\u2069]/g, '').replaceAll('\u00A0', ' ');
}

/** The amount and the date the row paints, in the order the row paints them. */
function paintedAmountAndDate(renderer: TestRenderer.ReactTestRenderer): {
  amount: string;
  date: string;
} {
  const painted = texts(renderer).map(text => readable(text));
  const amountIndex = painted.findIndex(text => /^[+-]?\$[\d,]+\.\d{2}$/.test(text));
  const amount = painted[amountIndex];
  const date = painted[amountIndex + 1];
  if (amount === undefined || date === undefined) {
    throw new Error('The row did not paint an amount and a date');
  }
  return { amount, date };
}

describe('PurchaseHistoryRow', () => {
  it('keeps the expiry line of a store-sold pack beside its store receipt note', async () => {
    const renderer = await renderRow(entry());

    const painted = texts(renderer).map(text => readable(text));
    // Play credits expire a year after purchase, so the receipt note cannot
    // replace the date the pack runs out: both lines belong on the row.
    expect(painted.some(text => text.startsWith('Expires') && text.endsWith('(UTC)'))).toBe(true);
    expect(painted).toContain('Receipt from Google Play');
    renderer.unmount();
  });

  it('keeps the store note for an App Store pack and the expiry beside it', async () => {
    const renderer = await renderRow(entry({ creditSource: 'apple' }));

    const painted = texts(renderer).map(text => readable(text));
    expect(painted.some(text => text.startsWith('Expires') && text.endsWith('(UTC)'))).toBe(true);
    expect(painted).toContain('Receipt from the App Store');
    renderer.unmount();
  });

  it('prints the expiry of a card purchase and its receipt action', async () => {
    const renderer = await renderRow(entry({ creditSource: 'stripe' }));

    const painted = texts(renderer).map(text => readable(text));
    expect(painted.some(text => text.startsWith('Expires') && text.endsWith('(UTC)'))).toBe(true);
    expect(painted.some(text => text.startsWith('Receipt from'))).toBe(false);
    expect(renderer.root.findAll(node => String(node.type) === 'Pressable').length).toBeGreaterThan(
      0
    );
    renderer.unmount();
  });

  it('names each card purchase receipt with its own amount and date', async () => {
    const earlier = await renderRow(
      entry({
        id: 'purchase-1',
        creditSource: 'stripe',
        date: '2026-10-26T10:00:00.000Z',
        amount_mUsd: 4_900_000,
      })
    );
    const later = await renderRow(
      entry({
        id: 'purchase-2',
        creditSource: 'stripe',
        date: '2026-11-02T10:00:00.000Z',
        amount_mUsd: 12_500_000,
      })
    );

    const earlierParts = paintedAmountAndDate(earlier);
    const laterParts = paintedAmountAndDate(later);
    const earlierLabel = readable(String(receiptLabelOf(earlier)));
    const laterLabel = readable(String(receiptLabelOf(later)));

    // Two purchases of the same kind must not share one accessible name: the
    // reader has to know which receipt the action opens.
    expect(earlierLabel).not.toBe(laterLabel);
    expect(earlierLabel).toContain(earlierParts.amount);
    expect(earlierLabel).toContain(earlierParts.date);
    expect(laterLabel).toContain(laterParts.amount);
    expect(laterLabel).toContain(laterParts.date);

    earlier.unmount();
    later.unmount();
  });
});

/** The row's own receipt action, which is the only pressable a card purchase paints. */
function receiptLabelOf(renderer: TestRenderer.ReactTestRenderer): unknown {
  const pressables = renderer.root.findAll(node => String(node.type) === 'Pressable');
  expect(pressables).toHaveLength(1);
  return pressables[0]?.props.accessibilityLabel;
}

describe('PurchaseHistoryRow in the reader language', () => {
  it('titles a card purchase in Arabic and opens its receipt in Arabic', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await renderRow(entry({ kind: 'purchase', creditSource: 'stripe' }));

      expect(texts(renderer)).toContain('شراء رصيد');
      const { amount, date } = paintedAmountAndDate(renderer);
      const label = readable(String(receiptLabelOf(renderer)));
      // The receipt sentence names its own purchase: the kind title, the
      // painted amount, and the painted date all read inside the sentence,
      // no matter what order the translation chooses. The verb phrase comes
      // from ar.json's own frame, so a fallback to the English sentence
      // cannot pass these checks.
      expect(label).toContain('شراء رصيد');
      expect(label).toContain('فتح إيصال');
      expect(label).toContain(amount);
      expect(label).toContain(date);
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('titles an automatic top-up in Arabic and opens its receipt in Arabic', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await renderRow(entry({ kind: 'auto_top_up', creditSource: 'stripe' }));

      expect(texts(renderer)).toContain('الشحن التلقائي');
      const { amount, date } = paintedAmountAndDate(renderer);
      const label = readable(String(receiptLabelOf(renderer)));
      expect(label).toContain('الشحن التلقائي');
      expect(label).toContain('فتح إيصال');
      expect(label).toContain(amount);
      expect(label).toContain(date);
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('titles an automatic top-up and a purchase in English', async () => {
    const topUp = await renderRow(entry({ kind: 'auto_top_up', creditSource: 'stripe' }));
    expect(texts(topUp)).toContain('Auto top-up');
    topUp.unmount();

    const purchase = await renderRow(entry({ kind: 'purchase', creditSource: 'stripe' }));
    expect(texts(purchase)).toContain('Credit purchase');
    purchase.unmount();
  });

  it('keeps the Arabic zone marker on the date line, in its own direction', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await renderRow(entry());

      const painted = texts(renderer);
      const expiry = painted.find(text => text.includes('(UTC)'));
      expect(expiry).toContain('\u00A0\u2068(UTC)\u2069');
      expect(expiry).not.toContain(' (UTC)');
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });
});

describe('LedgerHistoryRow', () => {
  it('titles a free grant from its reason and names the expiry that closed it', async () => {
    const renderer = await renderLedgerRow(
      deduction({ expiry: 'expired', purchase: deductionGrant() })
    );

    const painted = texts(renderer).map(text => readable(text));
    // The ledger stores an English description; both lines read the catalog
    // instead, so a grant the app knows never prints that stored sentence.
    expect(painted).toContain('Influencer credit');
    expect(painted).toContain('Expired: Influencer credit');
    expect(painted).not.toContain('influencer-bonus');
    expect(painted).not.toContain('Credit expired');
    renderer.unmount();
  });

  it('reads the grant title and the expiry in Arabic', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await renderLedgerRow(
        deduction({ expiry: 'expired', purchase: deductionGrant() })
      );

      const painted = texts(renderer).map(text => readable(text));
      expect(painted).toContain('رصيد المؤثرين');
      expect(painted).toContain('منتهي الصلاحية: رصيد المؤثرين');
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('keeps the stored description of a paid grant and names its expiry', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        expiry: 'expired',
        purchase: deductionGrant({
          is_free: false,
          credit_source: 'stripe',
          description: 'Credit purchase',
        }),
      })
    );

    const painted = texts(renderer).map(text => readable(text));
    // A paid grant's receipt records its own name, so the row keeps it rather
    // than replacing it with a program title the reader never bought.
    expect(painted).toContain('Credit purchase');
    expect(painted).toContain('Expired: Credit purchase');
    renderer.unmount();
  });

  it('keeps the ledger sentence on a row that is not an expiry', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        description: 'Usage charge against your grant',
        expiry: null,
        purchase: deductionGrant({
          is_free: false,
          credit_source: 'stripe',
          description: 'Credit purchase',
        }),
      })
    );

    const painted = texts(renderer).map(text => readable(text));
    // The row's own category is not an expiry, so its second line stays the
    // ledger's sentence instead of claiming the grant ended.
    expect(painted).toContain('Usage charge against your grant');
    expect(painted.some(text => text.startsWith('Expired: '))).toBe(false);
    renderer.unmount();
  });

  it('names the expiry once when the grant has its own purchase row above', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        description: 'Expired: Promotional credit',
        expiry: 'expired',
        purchase: deductionGrant({ description: 'promotional-bonus', kind: 'promotional' }),
      }),
      true
    );

    const painted = texts(renderer).map(text => readable(text));
    // The purchase row above already carries the grant, so this row paints the
    // expiry alone: the grant is titled from its reason, and the stored
    // sentence must not gain a second prefix.
    expect(painted).toContain('Expired: Promotional credits');
    expect(painted).not.toContain('Expired: Expired: Promotional credits');
    expect(painted).not.toContain('promotional-bonus');
    renderer.unmount();
  });

  it('keeps the stored description of an expiry row whose grant is not loaded', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        description: 'Expired: Promotional credit',
        expiry: 'expired',
        purchase: null,
      })
    );

    const painted = texts(renderer).map(text => readable(text));
    // Nothing here names the grant, and the stored sentence already states the
    // expiry, so the row may not wrap it again.
    expect(painted).toContain('Expired: Promotional credit');
    expect(painted).not.toContain('Expired: Expired: Promotional credit');
    renderer.unmount();
  });

  it('reads a voided grant as voided instead of expired', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        description: 'Credit voided from Orb system',
        expiry: 'voided',
        purchase: deductionGrant({ description: 'oss-bonus', kind: 'oss_sponsorship' }),
      })
    );

    const painted = texts(renderer).map(text => readable(text));
    // The server says the grant was cancelled, not that its term ran out, so
    // the line must not claim an expiry.
    expect(painted).toContain('Voided: OSS sponsorship credit');
    expect(painted.some(text => text.startsWith('Expired: '))).toBe(false);
    renderer.unmount();
  });

  it('names a paid grant whose stored description is empty', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        description: 'Expired: ',
        expiry: 'expired',
        purchase: deductionGrant({
          is_free: false,
          credit_source: 'stripe',
          description: '',
        }),
      })
    );

    const painted = texts(renderer).map(text => readable(text));
    // The ledger stores a description the server does not guarantee is
    // non-empty, and a blank title line reads as a broken row.
    expect(painted).toContain('Credit purchase');
    expect(painted).toContain('Expired: Credit purchase');
    expect(painted.some(text => text.trim() === 'Expired:')).toBe(false);
    renderer.unmount();
  });
});

describe('LedgerHistoryRow titles from the catalog', () => {
  it('titles a usage charge from the catalog instead of the stored sentence', async () => {
    const renderer = await renderLedgerRow(
      deduction({ reason: 'usage', description: 'Usage charge', expiry: null, purchase: null })
    );

    const painted = texts(renderer).map(text => readable(text));
    // The ledger stores an English sentence; a row whose category the server
    // names reads the catalog instead, in whatever language the reader chose.
    expect(painted).toContain(i18n.t('usage.title'));
    expect(painted).not.toContain('Usage charge');
    renderer.unmount();
  });

  it('titles a usage charge in Arabic', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await renderLedgerRow(
        deduction({ reason: 'usage', description: 'Usage charge', expiry: null, purchase: null })
      );

      const painted = texts(renderer).map(text => readable(text));
      expect(painted).toContain('الاستخدام');
      expect(painted).not.toContain('Usage charge');
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('names the coding plan a charge drew from, with the plan as a proper noun', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        reason: 'coding_plan',
        planName: 'MiniMax Token Plan Plus',
        description: 'Coding plan charge recorded for this period',
        expiry: null,
        purchase: null,
      })
    );

    const painted = texts(renderer).map(text => readable(text));
    // The stored sentence differs from the catalog template, so painting the
    // template proves the row reads the catalog rather than echoing the ledger.
    expect(painted).toContain(
      readable(i18n.t('credits.history.deduction.codingPlan', { plan: 'MiniMax Token Plan Plus' }))
    );
    expect(painted).not.toContain('Coding plan charge recorded for this period');
    renderer.unmount();
  });

  it('keeps the coding plan name intact inside the Arabic template', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await renderLedgerRow(
        deduction({
          reason: 'coding_plan',
          planName: 'MiniMax Token Plan Plus',
          description: 'Coding plan: MiniMax Token Plan Plus',
          expiry: null,
          purchase: null,
        })
      );

      const painted = texts(renderer).map(text => readable(text));
      const title = painted.find(text => text.includes('MiniMax Token Plan Plus'));
      if (title === undefined) {
        throw new Error('The row did not paint the coding plan name');
      }
      // The plan is a proper noun kept as data inside the Arabic frame, so the
      // sentence cannot be the English one with a translated prefix.
      expect(title).toBe(
        readable(
          i18n.t('credits.history.deduction.codingPlan', { plan: 'MiniMax Token Plan Plus' })
        )
      );
      expect(title).not.toBe('Coding plan: MiniMax Token Plan Plus');
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('keeps the ledger sentence on a row the server gave no reason', async () => {
    const renderer = await renderLedgerRow(
      deduction({ reason: null, description: 'Ledger sentence', expiry: null, purchase: null })
    );

    const painted = texts(renderer).map(text => readable(text));
    expect(painted).toContain('Ledger sentence');
    renderer.unmount();
  });

  it('keeps the ledger sentence on a coding plan charge whose plan is not named', async () => {
    const renderer = await renderLedgerRow(
      deduction({
        reason: 'coding_plan',
        planName: null,
        description: 'Coding plan renewal',
        expiry: null,
        purchase: null,
      })
    );

    const painted = texts(renderer).map(text => readable(text));
    // A renewal charge names no plan, so a template with an empty placeholder
    // would read as a broken row; the ledger's own sentence stays.
    expect(painted).toContain('Coding plan renewal');
    renderer.unmount();
  });
});

describe('GrantHistoryRow', () => {
  it('titles each grant kind in English', async () => {
    const referral = await renderGrantRow(grant({ kind: 'referral' }));
    expect(texts(referral)).toContain('Referral bonus');
    referral.unmount();

    const pass = await renderGrantRow(grant({ kind: 'kilo_pass' }));
    expect(texts(pass)).toContain('Kilo Pass');
    pass.unmount();

    const promotional = await renderGrantRow(grant({ kind: 'promotional' }));
    expect(texts(promotional)).toContain('Promotional credits');
    promotional.unmount();

    const welcome = await renderGrantRow(grant({ kind: 'welcome' }));
    expect(texts(welcome)).toContain('Welcome credits');
    welcome.unmount();
  });

  it('titles an accounting adjustment grant from the catalog', async () => {
    const renderer = await renderGrantRow(grant({ kind: 'adjustment' }));

    // The ledger correction is its own kind, so the row cannot fall back to the
    // generic grant title as if it were credit the person received.
    expect(texts(renderer)).toContain(i18n.t('credits.history.kind.adjustment'));
    renderer.unmount();
  });

  it.each([12_500_000, -1_000])('paints the grant amount and date for %i', async amount_mUsd => {
    const renderer = await renderGrantRow(grant({ amount_mUsd }));

    const { amount, date } = paintedAmountAndDate(renderer);
    expect(amount).toBe(amount_mUsd < 0 ? '$0.00' : '+$12.50');
    expect(date).toBe('11/12/2026');
    renderer.unmount();
  });

  it('prints when a grant runs out beside its date, and only the date with no term', async () => {
    const expiring = await renderGrantRow(grant({ expiryDate: '2027-11-12T00:00:00.000Z' }));
    const painted = texts(expiring).map(text => readable(text));
    // The expiry follows the date, the order the purchase row paints the pair.
    expect(painted.slice(-2)).toEqual([
      '11/12/2026',
      expect.stringMatching(/^Expires .+ \(UTC\)$/),
    ]);
    expiring.unmount();

    const openEnded = await renderGrantRow(grant({ expiryDate: null }));
    expect(
      texts(openEnded)
        .map(text => readable(text))
        .at(-1)
    ).toBe('11/12/2026');
    openEnded.unmount();
  });

  it('keeps the amount in its own left-to-right run in Arabic', async () => {
    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });
      const renderer = await renderGrantRow(grant({ kind: 'referral' }));

      const painted = texts(renderer);
      expect(painted).toContain('مكافأة الإحالة');
      const amount = painted.find(text => text.includes('$'));
      if (amount === undefined) {
        throw new Error('The grant row did not paint an amount');
      }
      // The isolates pin the run's direction; the paragraph's own direction
      // would otherwise reorder the sign against the digits.
      expect(amount.startsWith('\u2066')).toBe(true);
      expect(amount.endsWith('\u2069')).toBe(true);
      expect(readable(amount)).toBe('+$12.50');
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('retitles itself when the reader switches language in place', async () => {
    const renderer = await renderGrantRow(grant({ kind: 'referral' }));
    expect(texts(renderer)).toContain('Referral bonus');

    try {
      await act(async () => {
        await i18n.changeLanguage('ar');
      });

      // No remount and no new props: the row subscribes to the catalog itself.
      const painted = texts(renderer);
      expect(painted).toContain('مكافأة الإحالة');
      expect(painted).not.toContain('Referral bonus');
      renderer.unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });
});
