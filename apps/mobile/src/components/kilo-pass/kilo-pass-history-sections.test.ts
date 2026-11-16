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

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
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
  /** The entry's description, printed on its row. */
  entryText: string;
  render: (query: LedgerQuery, entries: 'none' | 'one') => Promise<TestRenderer.ReactTestRenderer>;
};

const SECTIONS: SectionCase[] = [
  {
    name: 'credit',
    emptyCopy: 'No Kilo Pass credits yet.',
    entryText: CREDIT_DESCRIPTION,
    render: (query, entries) =>
      renderElement(
        createElement(KiloPassCreditHistorySection, {
          history: { query, entries: entries === 'one' ? [CREDIT_ENTRY] : [], hasMore: false },
        })
      ),
  },
  {
    name: 'billing',
    emptyCopy: 'No billing history yet.',
    entryText: BILLING_DESCRIPTION,
    render: (query, entries) =>
      renderElement(
        createElement(KiloPassBillingHistorySection, {
          history: { query, entries: entries === 'one' ? [BILLING_ENTRY] : [], hasMore: false },
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
    expect(allText(renderer)).toContain("Couldn't load");
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
      expect(allText(renderer)).toContain("Couldn't load");
      expect(retryControls(renderer)).toHaveLength(0);
      expect(nodesOfType(renderer, 'Pressable')).toHaveLength(0);
      renderer.unmount();
    }
  );

  it('prints a loaded entry and no error copy', async () => {
    const renderer = await section.render(ledgerQuery(), 'one');
    const text = allText(renderer);
    expect(text).toContain(section.entryText);
    expect(text).not.toContain("Couldn't load");
    expect(retryControls(renderer)).toHaveLength(0);
    renderer.unmount();
  });
});
