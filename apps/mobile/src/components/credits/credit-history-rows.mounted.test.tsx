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
      expect(receiptLabelOf(renderer)).toBe('فتح إيصال شراء رصيد');
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
      expect(receiptLabelOf(renderer)).toBe('فتح إيصال الشحن التلقائي');
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
