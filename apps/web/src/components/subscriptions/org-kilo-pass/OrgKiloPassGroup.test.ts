import { createRequire } from 'node:module';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrgKiloPassGroup } from './OrgKiloPassGroup';

type QueryResult<T> = {
  data: T | undefined;
  isPending: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: Error | null;
  refetch: jest.Mock;
};

type Summary = {
  commercialState: 'active' | 'ended' | 'not_enrolled';
  agreement: typeof agreement | null;
  processingCondition: null;
};

type SeatSubscription = {
  latestSeatPurchaseStatus: 'active' | 'canceled' | 'past_due' | 'trialing' | null;
};

const agreement = {
  tier: 'tier_19',
  terms: {
    tier: 'tier_19',
    tierName: 'Starter',
    pricePerPassUsd: 19,
    baseCreditsPerPassUsd: 19,
    bonusCreditsPerPassUsd: 4,
    unlockSpendPerPassUsd: 19,
    bonusMode: 'after_base',
  },
  paidSeatCount: 6,
  cadence: 'monthly',
  paidThrough: '2026-08-27T00:00:00.000Z',
};

function success<T>(data: T): QueryResult<T> {
  return {
    data,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    isError: false,
    error: null,
    refetch: jest.fn(),
  };
}

function failure<T>(message: string, data?: T): QueryResult<T> {
  return {
    data,
    isPending: false,
    isFetching: false,
    isSuccess: false,
    isError: true,
    error: new Error(message),
    refetch: jest.fn(),
  };
}

function pending<T>(data?: T): QueryResult<T> {
  return {
    data,
    isPending: true,
    isFetching: true,
    isSuccess: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  };
}

function fetching<T>(data: T): QueryResult<T> {
  return { ...success(data), isFetching: true };
}

let mockOrganizationQuery: QueryResult<{ seat_count: number }>;
let mockSummaryQuery: QueryResult<Summary>;
let mockSeatQuery: QueryResult<SeatSubscription>;

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => mockOrganizationQuery,
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: {
      kiloPass: { summary: { queryOptions: () => ({ fixture: 'summary' }) } },
      subscription: { get: { queryOptions: () => ({ fixture: 'seats' }) } },
    },
  }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ fixture }: { fixture: string }) =>
    fixture === 'summary' ? mockSummaryQuery : mockSeatQuery,
}));

const previousReact = Reflect.get(globalThis, 'React');
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});

beforeEach(() => {
  mockOrganizationQuery = success({ seat_count: 6 });
  mockSummaryQuery = success({
    commercialState: 'not_enrolled',
    agreement: null,
    processingCondition: null,
  });
  mockSeatQuery = success({ latestSeatPurchaseStatus: 'active' });
});

function render(showTerminal = false): string {
  return renderToStaticMarkup(
    React.createElement(OrgKiloPassGroup, { organizationId: 'org-1', showTerminal, unframed: true })
  );
}

function actionButton(html: string, label: string): string {
  const labelIndex = html.indexOf(label);
  expect(labelIndex).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<button', labelIndex);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('>', start));
}

describe('OrgKiloPassGroup', () => {
  test.each([
    ['failure', () => failure<SeatSubscription>('Seat lookup failed')],
    ['loading', () => pending<SeatSubscription>()],
    ['fetching', () => fetching<SeatSubscription>({ latestSeatPurchaseStatus: 'active' })],
  ])('renders an active agreement while the seat query is in %s', (_state, seatQuery) => {
    mockSummaryQuery = success({ commercialState: 'active', agreement, processingCondition: null });
    mockSeatQuery = seatQuery();

    const html = render();

    expect(html).toContain('Starter add-on · 6 paid seats covered');
    expect(html).toContain('href="/organizations/org-1/subscriptions/kilo-pass"');
    expect(html).not.toContain('Unable to load');
    expect(html).not.toContain('Seat lookup failed');
  });

  test.each([
    ['failure', () => failure<SeatSubscription>('Seat lookup failed')],
    ['loading', () => pending<SeatSubscription>()],
    ['fetching', () => fetching<SeatSubscription>({ latestSeatPurchaseStatus: 'active' })],
  ])('renders an ended agreement while the seat query is in %s', (_state, seatQuery) => {
    mockSummaryQuery = success({ commercialState: 'ended', agreement, processingCondition: null });
    mockSeatQuery = seatQuery();

    const html = render(true);

    expect(html).toContain('Starter add-on · 6 paid seats covered');
    expect(html).toContain('href="/organizations/org-1/subscriptions/kilo-pass"');
    expect(html).not.toContain('Unable to load');
    expect(html).not.toContain('Seat lookup failed');
  });

  test.each([
    ['failed', () => failure<SeatSubscription>('Seat lookup failed')],
    [
      'missing',
      () => ({ ...success<SeatSubscription>({ latestSeatPurchaseStatus: null }), data: undefined }),
    ],
    ['inactive', () => success<SeatSubscription>({ latestSeatPurchaseStatus: 'canceled' })],
    ['past due', () => success<SeatSubscription>({ latestSeatPurchaseStatus: 'past_due' })],
    ['trialing', () => success<SeatSubscription>({ latestSeatPurchaseStatus: 'trialing' })],
    ['unknown', () => success<SeatSubscription>({ latestSeatPurchaseStatus: null })],
    [
      'failed with stale active data',
      () => failure<SeatSubscription>('Seat lookup failed', { latestSeatPurchaseStatus: 'active' }),
    ],
    [
      'failed with stale inactive data',
      () =>
        failure<SeatSubscription>('Seat lookup failed', { latestSeatPurchaseStatus: 'canceled' }),
    ],
  ])('disables the available action when seat status is %s', (_state, seatQuery) => {
    mockSeatQuery = seatQuery();

    const html = render();

    expect(actionButton(html, 'Add Kilo Pass')).toContain('disabled=""');
    expect(html).not.toContain('href="/organizations/org-1/subscriptions/kilo-pass/setup"');
    expect(html).not.toContain('Unable to load');
  });

  test.each([
    ['pending', () => pending<SeatSubscription>()],
    [
      'fetching with cached active data',
      () => fetching<SeatSubscription>({ latestSeatPurchaseStatus: 'active' }),
    ],
  ])(
    'shows loading rather than an available action when seat status is %s',
    (_state, seatQuery) => {
      mockSeatQuery = seatQuery();

      const html = render();

      expect(html).toContain('animate-pulse');
      expect(html).not.toContain('Add Kilo Pass');
      expect(html).not.toContain('href="/organizations/org-1/subscriptions/kilo-pass/setup"');
    }
  );

  test.each([
    ['no cached data', undefined],
    ['cached active data', { latestSeatPurchaseStatus: 'active' }],
    ['cached inactive data', { latestSeatPurchaseStatus: 'canceled' }],
  ] satisfies Array<[string, SeatSubscription | undefined]>)(
    'offers retry without asserting seats are missing on failure with %s',
    (_state, cachedData) => {
      mockSeatQuery = failure('Seat lookup failed', cachedData);

      const html = render();

      expect(html).toContain('Unable to verify your seat subscription');
      expect(html).toContain('Retry');
      expect(html).toContain('Monthly Credits for each paid seat');
      expect(html).not.toContain('Subscribe to seats first');
      expect(html).not.toContain('Monthly Credits for all 6 paid seats');
      expect(actionButton(html, 'Add Kilo Pass')).toContain('disabled=""');
    }
  );

  test('retries the seat lookup and enables the action after recovery', async () => {
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    const globals = {
      window,
      self: window,
      document,
      HTMLElement: window.HTMLElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    const container = document.getElementById('root');
    if (!container) throw new Error('Test root missing');
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    mockSeatQuery = failure('Seat lookup failed');
    const refetch = mockSeatQuery.refetch;
    const element = React.createElement(OrgKiloPassGroup, {
      organizationId: 'org-1',
      unframed: true,
    });

    try {
      act(() => root.render(element));
      const retry = [...container.querySelectorAll('button')].find(button =>
        button.textContent?.includes('Retry seat status')
      );
      expect(retry).toBeDefined();
      act(() => {
        retry?.dispatchEvent(new window.Event('click', { bubbles: true }));
      });
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(mockSummaryQuery.refetch).not.toHaveBeenCalled();
      expect(mockOrganizationQuery.refetch).not.toHaveBeenCalled();

      mockSeatQuery = success({ latestSeatPurchaseStatus: 'active' });
      act(() => root.render(React.cloneElement(element)));
      expect(container.innerHTML).toContain(
        'href="/organizations/org-1/subscriptions/kilo-pass/setup"'
      );
      expect(actionButton(container.innerHTML, 'Add Kilo Pass')).not.toContain('disabled=""');
    } finally {
      act(() => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test('enables the available action when an active seat purchase is confirmed', () => {
    const html = render();

    expect(actionButton(html, 'Add Kilo Pass')).not.toContain('disabled=""');
    expect(html).toContain('href="/organizations/org-1/subscriptions/kilo-pass/setup"');
  });

  test.each([
    ['seat lookup fails', () => failure<SeatSubscription>('Seat lookup failed')],
    [
      'seat purchase is inactive',
      () => success<SeatSubscription>({ latestSeatPurchaseStatus: 'canceled' }),
    ],
  ])(
    'preserves ended agreement details without promising a restart when %s',
    (_state, seatQuery) => {
      mockSummaryQuery = success({
        commercialState: 'ended',
        agreement,
        processingCondition: null,
      });
      mockSeatQuery = seatQuery();

      const html = render();

      expect(html).toContain('Your previous Kilo Pass for Organizations ended');
      expect(html).not.toContain('Monthly Credits can restart right away');
      expect(actionButton(html, 'Add Kilo Pass again')).toContain('disabled=""');
      expect(html).not.toContain('href="/organizations/org-1/subscriptions/kilo-pass/setup"');
    }
  );

  test('enables restart for an ended agreement when an active seat purchase is confirmed', () => {
    mockSummaryQuery = success({ commercialState: 'ended', agreement, processingCondition: null });

    const html = render();

    expect(html).toContain('Monthly Credits can restart right away');
    expect(actionButton(html, 'Add Kilo Pass again')).not.toContain('disabled=""');
    expect(html).toContain('href="/organizations/org-1/subscriptions/kilo-pass/setup"');
  });

  test.each(['organization', 'summary'] as const)('surfaces a required %s query error', query => {
    if (query === 'organization') mockOrganizationQuery = failure('Organization lookup failed');
    else mockSummaryQuery = failure('Summary lookup failed');

    const html = render();

    expect(html).toContain('Unable to load kilo pass for organizations');
    expect(html).toContain(
      query === 'organization' ? 'Organization lookup failed' : 'Summary lookup failed'
    );
    expect(html).toContain('Retry');
    expect(html).not.toContain('Add Kilo Pass');
  });

  test.each(['organization', 'summary'] as const)(
    'surfaces a required %s query error while other queries are pending',
    query => {
      mockOrganizationQuery =
        query === 'organization' ? failure('Organization lookup failed') : pending();
      mockSummaryQuery = query === 'summary' ? failure('Summary lookup failed') : pending();
      mockSeatQuery = pending();

      const html = render();

      expect(html).toContain('Unable to load kilo pass for organizations');
      expect(html).toContain(
        query === 'organization' ? 'Organization lookup failed' : 'Summary lookup failed'
      );
      expect(html).toContain('Retry');
      expect(html).not.toContain('animate-pulse');
    }
  );

  test.each(['organization', 'summary'] as const)(
    'shows loading while the required %s query is pending',
    query => {
      if (query === 'organization') mockOrganizationQuery = pending();
      else mockSummaryQuery = pending();

      const html = render();

      expect(html).toContain('animate-pulse');
      expect(html).not.toContain('Add Kilo Pass');
      expect(html).not.toContain('Unable to load');
    }
  );
});
