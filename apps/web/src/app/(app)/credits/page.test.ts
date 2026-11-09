/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest mocks must be registered before loading the page. */
// The web Jest config matches `*.test.ts`, so the page is rendered through
// `createElement` and the module mocks below must be registered before it loads.
import { jest } from '@jest/globals';
import React, { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

type QueryResult = {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
};

let queryResults: Record<string, QueryResult> = {};

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryResults[String(queryKey[0])] ?? {
      data: undefined,
      isLoading: false,
      isError: false,
      error: undefined,
      refetch: () => {},
    },
  useMutation: () => ({ mutateAsync: async () => ({ url: null }), isPending: false }),
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    user: {
      getCreditBlocks: { queryOptions: () => ({ queryKey: ['creditBlocks'] }) },
      getCreditPurchaseHistory: { queryOptions: () => ({ queryKey: ['purchaseHistory'] }) },
      getCreditPurchaseConfirmation: { queryOptions: () => ({ queryKey: ['confirmation'] }) },
      getPaidCreditPolicy: { queryOptions: () => ({ queryKey: ['policy'] }) },
      getCreditPurchaseReceipt: { mutationOptions: () => ({}) },
    },
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: ReactElement }) => children,
}));

jest.mock('@/components/payment/CreditPurchaseOptions', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'Buy Credits'),
}));

jest.mock('@/components/payment/AutoTopUpToggle', () => ({
  AutoTopUpToggle: () => createElement('div', null, 'Automatic Top Up'),
}));

jest.mock('sonner', () => ({ toast: { error: () => {} } }));

const { default: CreditsPage } = require('./page') as { default: () => ReactElement };

const deductions = [
  {
    id: 'expiry-1',
    date: '2026-09-01T00:00:00Z',
    description: 'Expired: Promotional credits',
    amount_mUsd: -50_000_000,
    kind: 'adjustment',
    purchase: {
      id: 'grant-1',
      date: '2025-09-01T00:00:00Z',
      description: 'Promotional credits',
      amount_mUsd: 50_000_000,
      is_free: true,
      credit_source: null,
    },
  },
  {
    id: 'usage-1',
    date: '2026-09-15T00:00:00Z',
    description: 'Usage charge',
    amount_mUsd: -3_000_000,
    kind: 'deduction',
    purchase: null,
  },
];

function renderPage(policy: { creditExpiryPolicy: 'one_year' | 'never' } | undefined): string {
  queryResults = {
    creditBlocks: {
      data: {
        creditBlocks: [],
        deductions,
        totalBalance_mUsd: 0,
        isFirstPurchase: false,
        autoTopUpEnabled: false,
      },
      isLoading: false,
      isError: false,
      error: undefined,
      refetch: () => {},
    },
    purchaseHistory: {
      data: { entries: [], previousCursor: null, nextCursor: null },
      isLoading: false,
      isError: false,
      error: undefined,
      refetch: () => {},
    },
    confirmation: {
      data: undefined,
      isLoading: false,
      isError: false,
      error: undefined,
      refetch: () => {},
    },
    policy: {
      data: policy,
      isLoading: false,
      isError: false,
      error: undefined,
      refetch: () => {},
    },
  };

  return renderToStaticMarkup(createElement(CreditsPage));
}

describe('CreditsPage', () => {
  it('states the live purchased-credit term and pairs an expiry with its grant', () => {
    const html = renderPage({ creditExpiryPolicy: 'one_year' });

    expect(html).toContain('Purchased credits');
    expect(html).toContain('Expire one year after purchase');
    // The grant leads the pair, the expiry follows as its second line.
    const grantAt = html.indexOf('Promotional credits');
    const expiryAt = html.indexOf('Expired: Promotional credits');
    expect(grantAt).toBeGreaterThan(-1);
    expect(expiryAt).toBeGreaterThan(grantAt);
    expect(html.slice(grantAt, expiryAt)).toContain('Credit grant');
    expect(html.slice(grantAt, expiryAt)).toContain('+$50.00');
    // The marker and the expiry amount sit in the expiry's own row.
    const expiryRow = html.slice(
      html.lastIndexOf('<tr', expiryAt),
      html.indexOf('</tr>', expiryAt)
    );
    expect(expiryRow).toContain('└');
    expect(expiryRow).toContain('Expired: Promotional credits');
    expect(expiryRow).toContain('-$50.00');
    // Both lines live in one group, so one zebra stripe and one divider.
    const group = html.slice(
      html.lastIndexOf('<tbody', expiryAt),
      html.indexOf('</tbody>', expiryAt)
    );
    expect(group).toContain('Promotional credits');
    expect(group).toContain('Expired: Promotional credits');
    expect(group).not.toContain('Usage charge');
    // An unpaired charge keeps its own row.
    expect(html).toContain('Usage charge');
    expect(html).toContain('-$3.00');
  });

  it('never promises expiry while the policy is off', () => {
    const html = renderPage({ creditExpiryPolicy: 'never' });

    expect(html).toContain('Do not expire');
    expect(html).not.toContain('Expire one year after purchase');
  });

  it('does not claim a term before the policy answers', () => {
    const html = renderPage(undefined);

    expect(html).toContain('Loading terms...');
    expect(html).not.toContain('Do not expire');
  });
});
