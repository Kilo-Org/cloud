import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { type CreditPurchaseEntry } from '@/lib/credits/credit-history';

import { PurchaseHistoryRow } from './credit-history-rows';

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

async function renderRow(purchase: CreditPurchaseEntry) {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(
      createElement(PurchaseHistoryRow, {
        entry: purchase,
        isOpeningReceipt: false,
        onOpenReceipt: () => undefined,
      })
    );
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
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
  const amountIndex = painted.findIndex(text => text.startsWith('+') || text.startsWith('-'));
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
      // no matter what order the translation chooses.
      expect(label).toContain('شراء رصيد');
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
