import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { EnkryptUsageTab as EnkryptUsageTabComponent } from './EnkryptUsageTab';
import type { RequestLogsPage as RequestLogsPageComponent } from './RequestLogsPage';

let mockSearchParams = new URLSearchParams();
let RequestLogsPage: typeof RequestLogsPageComponent;
let EnkryptUsageTab: typeof EnkryptUsageTabComponent;

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/organizations/org-1/request-logs',
  useRouter: () => ({ replace: jest.fn() }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: [],
    dataUpdatedAt: 0,
    isPending: false,
    isFetching: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: { requestLogs: { list: { queryOptions: () => ({}) } } },
  }),
}));

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({ data: { members: [] } }),
}));

jest.mock('@/components/organizations/OrganizationPageHeader', () => ({
  OrganizationPageHeader: () => null,
}));

jest.mock('./RequestLogDetailsSheet', () => ({
  RequestLogDetailsSheet: () => null,
}));

jest.mock('./detail-primitives', () => ({ ABSENT_CELL: '-' }));

jest.mock('./EnkryptUsageTab', () => ({
  EnkryptUsageTab: jest.fn(() => createElement('div', null, 'Enkrypt usage content')),
  parseEnkryptFilters: () => ({
    startTime: null,
    userId: null,
    outcome: null,
    guardrail: null,
  }),
}));

const originalReact = Object.getOwnPropertyDescriptor(globalThis, 'React');

beforeAll(async () => {
  Object.defineProperty(globalThis, 'React', { configurable: true, writable: true, value: React });
  ({ RequestLogsPage } = await import('./RequestLogsPage'));
  ({ EnkryptUsageTab } = await import('./EnkryptUsageTab'));
});

afterAll(() => {
  if (originalReact) Object.defineProperty(globalThis, 'React', originalReact);
  else Reflect.deleteProperty(globalThis, 'React');
});

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  jest.clearAllMocks();
});

function render(enkryptEnabled: boolean) {
  const markup = renderToStaticMarkup(
    createElement(RequestLogsPage, { organizationId: 'org-1', enkryptEnabled })
  );
  return parseHTML(markup).document;
}

describe('RequestLogsPage Enkrypt entitlement', () => {
  it.each(['', 'tab=enkrypt'])(
    'hides Enkrypt and keeps Requests active without entitlement for query "%s"',
    query => {
      mockSearchParams = new URLSearchParams(query);

      const document = render(false);

      expect(Array.from(document.querySelectorAll('[role="tab"]'), tab => tab.textContent)).toEqual(
        ['Requests']
      );
      expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
        'Requests'
      );
      expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
      expect(
        document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent
      ).toContain('No requests in the hour before the start time.');
      expect(document.documentElement.textContent).not.toContain('Enkrypt usage content');
      expect(EnkryptUsageTab).not.toHaveBeenCalled();
    }
  );

  it('shows Enkrypt with entitlement while keeping Requests active by default', () => {
    const document = render(true);

    expect(Array.from(document.querySelectorAll('[role="tab"]'), tab => tab.textContent)).toEqual([
      'Requests',
      'Enkrypt',
    ]);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Requests'
    );
    expect(document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent).toContain(
      'No requests in the hour before the start time.'
    );
    expect(document.documentElement.textContent).not.toContain('Enkrypt usage content');
    expect(EnkryptUsageTab).not.toHaveBeenCalled();
  });

  it('selects and mounts Enkrypt for its deep link with entitlement', () => {
    mockSearchParams = new URLSearchParams('tab=enkrypt');

    const document = render(true);

    expect(Array.from(document.querySelectorAll('[role="tab"]'), tab => tab.textContent)).toEqual([
      'Requests',
      'Enkrypt',
    ]);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Enkrypt'
    );
    expect(document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent).toBe(
      'Enkrypt usage content'
    );
    expect(document.documentElement.textContent).not.toContain(
      'No requests in the hour before the start time.'
    );
    expect(EnkryptUsageTab).toHaveBeenCalledTimes(1);
    expect(jest.mocked(EnkryptUsageTab).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ organizationId: 'org-1' })
    );
  });
});
