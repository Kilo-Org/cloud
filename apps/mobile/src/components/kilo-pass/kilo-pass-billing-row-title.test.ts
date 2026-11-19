// The billing row reads the invoice line the server typed, so one table covers
// the charge kinds and another the rows the provider's own sentence still has to
// title. The section's paging, skeleton and error cases live beside it in
// kilo-pass-history-sections.test.ts.

import { createElement, type ReactElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KiloPassBillingHistorySection } from './kilo-pass-history-sections';
import { i18n } from '@/i18n';
import { type KiloPassCreditHistory } from '@/lib/hooks/use-kilo-pass-history';
import { type KiloPassBillingEntry } from '@/lib/kilo-pass/management';
import { act, TestRenderer } from '@/test/renderer';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#ff3b30' }),
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }),
  };
});

/** The provider-billed member of the billing entry union. */
type StripeEntry = Extract<KiloPassBillingEntry, { kind: 'stripe' }>;
type StripeLine = NonNullable<StripeEntry['line']>;

const ENTRY: StripeEntry = {
  kind: 'stripe',
  id: 'billing-1',
  date: '2026-10-05T12:00:00.000Z',
  amountCents: 4900,
  currency: 'usd',
  status: 'paid',
  invoiceUrl: null,
  invoicePdfUrl: null,
  description: null,
  line: null,
};

const QUERY: KiloPassCreditHistory['query'] = {
  isPending: false,
  isError: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  error: null,
  refetch: vi.fn<() => void>(),
  fetchNextPage: vi.fn<() => void>(),
};

/** The provider's own sentence, which names the plan and its identifiers. */
const PROVIDER_DESCRIPTION = 'Kilo Pass subscription (tier_49, streak=3)';

/** A typed invoice line, with the title the row prints for it. */
const TYPED_LINES: [string, StripeLine, string][] = [
  ['trial', { kind: 'trial', tier: 'tier_19' as const }, 'Free trial · Starter'],
  ['initial', { kind: 'initial', tier: 'tier_49' as const }, 'First charge · Pro'],
  ['renewal', { kind: 'renewal', tier: 'tier_199' as const }, 'Renewal · Expert'],
  // A line that names no tier still names the charge, and the tier falls back to
  // the pass's own name.
  ['upgrade', { kind: 'upgrade', tier: null }, 'Plan change · Kilo Pass'],
];

/** The rows a typed line cannot name: the title, the description and the line. */
const UNTYPED_ROWS: [string, string | null, StripeLine | null][] = [
  ['Subscription', PROVIDER_DESCRIPTION, { kind: 'unknown', tier: 'tier_49' }],
  ['Invoice', 'Kilo Pass invoice (tier_49, streak=4)', null],
  ['Kilo Pass', null, null],
];

/** The literal children of every rendered Text node, in render order. */
function rowTitles(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
}

async function renderRow(
  description: string | null,
  line: StripeLine | null
): Promise<TestRenderer.ReactTestRenderer> {
  const element: ReactElement = createElement(KiloPassBillingHistorySection, {
    history: { query: QUERY, entries: [{ ...ENTRY, description, line }], hasMore: false },
  });
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

// The typed line beats the provider's sentence: it says what the charge was and
// the tier it billed, in the reader's language, and never repeats the product
// name, plan id, cadence or streak the header and the row already carry.
describe('billing row titles', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each(TYPED_LINES)('names a %s line with its tier', async (_kind, line, expected) => {
    const renderer = await renderRow(PROVIDER_DESCRIPTION, line);
    const titles = rowTitles(renderer);
    expect(titles).toContain(expected);
    expect(titles.join(' ')).not.toMatch(/tier_\d|remaining_months|streak=/);
    renderer.unmount();
  });

  it.each(UNTYPED_ROWS)(
    'prints the %s title from the description',
    async (expected, description, line) => {
      const renderer = await renderRow(description, line);
      const titles = rowTitles(renderer);
      expect(titles).toContain(expected);
      expect(titles.join(' ')).not.toMatch(/tier_\d|remaining_months|streak=/);
      renderer.unmount();
    }
  );

  it('prints the row in the active locale', async () => {
    await i18n.changeLanguage('de');
    const renderer = await renderRow(PROVIDER_DESCRIPTION, { kind: 'renewal', tier: 'tier_49' });
    const localized = i18n.t('kiloPass.manage.billingRowRenewal', {
      tier: i18n.t('kiloPass.tierPro'),
    });
    const titles = rowTitles(renderer);
    expect(titles).toContain(localized);
    expect(titles).not.toContain('Renewal · Pro');
    renderer.unmount();
  });
});
