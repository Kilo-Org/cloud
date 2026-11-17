// Both ledger sections read the same paging state and differ only in the entry
// type they print, so one case table covers the ended page's two histories.

import { createElement, type ReactElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KiloPassBillingHistorySection,
  KiloPassCreditHistorySection,
} from './kilo-pass-history-sections';
import { i18n } from '@/i18n';
import { type KiloPassCreditHistory } from '@/lib/hooks/use-kilo-pass-history';
import { type KiloPassBillingEntry, type KiloPassCreditEntry } from '@/lib/kilo-pass/management';
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

type LedgerQuery = KiloPassCreditHistory['query'];

function ledgerQuery(overrides: Partial<LedgerQuery> = {}): LedgerQuery {
  return {
    isPending: false,
    isError: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    error: null,
    refetch: vi.fn<() => void>(),
    fetchNextPage: vi.fn<() => void>(),
    ...overrides,
  };
}

const CREDIT_DESCRIPTION = 'Monthly Kilo Pass credits';
const BILLING_DESCRIPTION = 'Kilo Pass invoice';

const CREDIT_ENTRY: KiloPassCreditEntry = {
  id: 'credit-1',
  date: '2026-10-05T12:00:00.000Z',
  amountUsd: 12,
  expiryDate: null,
  // The server's string enum is not a runtime dependency of the mobile app, so
  // the fixture carries the enum's own wire value.
  kind: 'base' as KiloPassCreditEntry['kind'],
  description: CREDIT_DESCRIPTION,
};

const BILLING_ENTRY: KiloPassBillingEntry = {
  kind: 'stripe',
  id: 'billing-1',
  date: '2026-10-05T12:00:00.000Z',
  amountCents: 4900,
  currency: 'usd',
  status: 'paid',
  invoiceUrl: null,
  invoicePdfUrl: null,
  description: BILLING_DESCRIPTION,
};

/** The first-page failure codes the section classifies. */
const RETRYABLE_ERROR = { data: { code: 'INTERNAL_SERVER_ERROR' } };
// A refused read and an unprocessable one can never succeed on a second ask.
const PERMANENT_ERRORS = [{ code: 'FORBIDDEN' }, { code: 'BAD_REQUEST' }] as const;

async function renderElement(element: ReactElement): Promise<TestRenderer.ReactTestRenderer> {
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

type SectionCase = {
  name: string;
  /** The copy a ledger with no entries prints. */
  emptyCopy: string;
  /** The copy a failed first page prints. */
  errorCopy: string;
  /** The entry's description, printed on its row. */
  entryText: string;
  render: (
    query: LedgerQuery,
    entries: 'none' | 'one',
    hasMore?: boolean
  ) => Promise<TestRenderer.ReactTestRenderer>;
};

const SECTIONS: SectionCase[] = [
  {
    name: 'credit',
    emptyCopy: 'No Kilo Pass credits yet.',
    errorCopy: "Couldn't load credit history",
    entryText: CREDIT_DESCRIPTION,
    render: (query, entries, hasMore = false) =>
      renderElement(
        createElement(KiloPassCreditHistorySection, {
          history: { query, entries: entries === 'one' ? [CREDIT_ENTRY] : [], hasMore },
        })
      ),
  },
  {
    name: 'billing',
    emptyCopy: 'No billing history yet.',
    errorCopy: "Couldn't load billing history",
    entryText: BILLING_DESCRIPTION,
    render: (query, entries, hasMore = false) =>
      renderElement(
        createElement(KiloPassBillingHistorySection, {
          history: { query, entries: entries === 'one' ? [BILLING_ENTRY] : [], hasMore },
        })
      ),
  },
];

function nodesOfType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => String(node.type) === type);
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  const texts: string[] = [];
  const walk = (instance: TestRenderer.ReactTestInstance): void => {
    for (const child of instance.children) {
      if (typeof child === 'string') {
        texts.push(child);
      } else if (typeof child === 'number') {
        texts.push(String(child));
      } else {
        walk(child);
      }
    }
  };
  walk(renderer.root);
  return texts.join(' ');
}

/** The retry affordance: a control the screen reader names "Retry". */
function retryControls(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => node.props.accessibilityLabel === 'Retry');
}

/** The paging affordance: a control the screen reader names "Load more". */
function loadMoreControls(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => node.props.accessibilityLabel === 'Load more');
}

describe.each(SECTIONS)('$name history section', section => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows a skeleton and no row while the first page is pending', async () => {
    const renderer = await section.render(ledgerQuery({ isPending: true }), 'none');
    expect(nodesOfType(renderer, 'Skeleton').length).toBeGreaterThan(0);
    expect(allText(renderer)).not.toContain(section.entryText);
    expect(retryControls(renderer)).toHaveLength(0);
    renderer.unmount();
  });

  it('says the ledger is empty when it has no entries', async () => {
    const renderer = await section.render(ledgerQuery(), 'none');
    expect(allText(renderer)).toContain(section.emptyCopy);
    renderer.unmount();
  });

  it('offers Retry when the first page failed retryably', async () => {
    const renderer = await section.render(
      ledgerQuery({ isError: true, error: RETRYABLE_ERROR }),
      'none'
    );
    expect(allText(renderer)).toContain(section.errorCopy);
    expect(nodesOfType(renderer, 'AlertCircle')).toHaveLength(1);
    expect(retryControls(renderer)).toHaveLength(1);
    renderer.unmount();
  });

  it.each(PERMANENT_ERRORS)(
    'prints the refusal without Retry for a $code failure',
    async permanent => {
      const renderer = await section.render(
        ledgerQuery({ isError: true, error: { data: { code: permanent.code } } }),
        'none'
      );
      expect(allText(renderer)).toContain(section.errorCopy);
      expect(retryControls(renderer)).toHaveLength(0);
      // The terminal case renders no sort of Retry control: the success-path
      // affordance it replaces is itself an ordinary button, so the gate is
      // the node that a caller without a retry cannot print.
      expect(nodesOfType(renderer, 'Button')).toHaveLength(0);
      renderer.unmount();
    }
  );

  it('offers Load more while the next page has not failed', async () => {
    const renderer = await section.render(ledgerQuery(), 'one', true);
    expect(loadMoreControls(renderer)).toHaveLength(1);
    renderer.unmount();
  });

  it('replaces Load more with one Retry when a later page failed retryably', async () => {
    const renderer = await section.render(
      ledgerQuery({ isFetchNextPageError: true, error: RETRYABLE_ERROR }),
      'one',
      true
    );
    expect(allText(renderer)).toContain("Couldn't load more");
    // The failed page's own line owns the affordance; the button that started it
    // would only fail again.
    expect(loadMoreControls(renderer)).toHaveLength(0);
    expect(retryControls(renderer)).toHaveLength(1);
    renderer.unmount();
  });

  it.each(PERMANENT_ERRORS)(
    'leaves no affordance when a later page failed with $code',
    async permanent => {
      const renderer = await section.render(
        ledgerQuery({ isFetchNextPageError: true, error: { data: { code: permanent.code } } }),
        'one',
        true
      );
      expect(allText(renderer)).toContain("Couldn't load more");
      expect(loadMoreControls(renderer)).toHaveLength(0);
      expect(retryControls(renderer)).toHaveLength(0);
      renderer.unmount();
    }
  );

  it('prints a loaded entry and no error copy', async () => {
    const renderer = await section.render(ledgerQuery(), 'one');
    const text = allText(renderer);
    expect(text).toContain(section.entryText);
    expect(text).not.toContain(section.errorCopy);
    expect(retryControls(renderer)).toHaveLength(0);
    renderer.unmount();
  });
});

/** The literal children of every rendered Text node, in render order. */
function textNodeChildren(renderer: TestRenderer.ReactTestRenderer): string[] {
  return nodesOfType(renderer, 'Text').flatMap(node =>
    node.children.filter((child): child is string => typeof child === 'string')
  );
}

function creditEntry(description: string): KiloPassCreditEntry {
  return { ...CREDIT_ENTRY, description };
}

// The screen header already prints "Kilo Pass" and names the plan and cadence,
// so each row title drops that leading product name and the server's trailing
// parenthesis of internal identifiers, and keeps the part that tells the rows
// apart.
describe('credit row titles', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each([
    ['Kilo Pass monthly credits — Tier 19', 'Monthly credits — Tier 19'],
    // The shapes the server writes for a pass grant, each with its own
    // parenthesis of plan id, cadence, streak or issue month.
    ['Kilo Pass base credits (tier_49, monthly)', 'Base credits'],
    ['Kilo Pass base credits (tier_19, yearly, 2026-11)', 'Base credits'],
    [
      'Kilo Pass yearly remaining base credits (tier_49, remaining_months=3)',
      'Yearly remaining base credits',
    ],
    ['Kilo Pass promo 50% bonus (tier_19, streak=1)', 'Promo 50% bonus'],
    ['Kilo Pass referral bonus (2026-11)', 'Referral bonus'],
    // No leading product name: the description prints exactly as the server sent it.
    [CREDIT_DESCRIPTION, CREDIT_DESCRIPTION],
  ])('prints the row for %s as %s', async (description, expected) => {
    const renderer = await renderElement(
      createElement(KiloPassCreditHistorySection, {
        history: { query: ledgerQuery(), entries: [creditEntry(description)], hasMore: false },
      })
    );
    const titles = textNodeChildren(renderer);
    expect(titles).toContain(expected);
    if (description !== expected) {
      expect(titles).not.toContain(description);
    }
    expect(titles.join(' ')).not.toMatch(/tier_\d|remaining_months|streak=/);
    renderer.unmount();
  });

  it('falls back to the section name when the description is only identifiers', async () => {
    const renderer = await renderElement(
      createElement(KiloPassCreditHistorySection, {
        history: {
          query: ledgerQuery(),
          entries: [creditEntry('Kilo Pass (tier_49, monthly)')],
          hasMore: false,
        },
      })
    );
    const titles = textNodeChildren(renderer);
    expect(titles).toContain(i18n.t('common.creditHistory'));
    expect(titles.join(' ')).not.toMatch(/tier_49/);
    renderer.unmount();
  });
});
