import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockQueryOptions: {
  enabled?: boolean;
  refetchInterval?: number | false;
  refetchOnWindowFocus?: boolean;
}[] = [];

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: any) => {
    mockQueryOptions.push(options);
    return { data: undefined, refetch: jest.fn(), isLoading: false };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    stepUp: {
      getStatus: { queryOptions: () => ({ queryKey: ['step-up-status'] }) },
      revokeCurrent: { mutationOptions: (options: unknown) => options },
    },
  }),
}));
jest.mock('./StepUpProvider', () => ({ useStepUp: () => ({ requestStepUp: jest.fn() }) }));
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));
jest.mock('next/navigation', () => ({ usePathname: () => '/admin' }));

import type { AdminStepUpStatus as AdminStepUpStatusComponent } from './AdminStepUpStatus';

let AdminStepUpStatus!: typeof AdminStepUpStatusComponent;

beforeAll(async () => {
  ({ AdminStepUpStatus } = await import('./AdminStepUpStatus'));
});

describe('AdminStepUpStatus', () => {
  beforeEach(() => {
    mockQueryOptions.length = 0;
  });

  it('renders nothing and disables polling when the server hides it', () => {
    const markup = renderToStaticMarkup(React.createElement(AdminStepUpStatus, { visible: false }));

    expect(markup).toBe('');
    expect(mockQueryOptions).toHaveLength(1);
    expect(mockQueryOptions[0]?.enabled).toBe(false);
    expect(mockQueryOptions[0]?.refetchInterval).toBe(false);
    expect(mockQueryOptions[0]?.refetchOnWindowFocus).toBe(false);
  });

  it('enables the status query when visible', () => {
    renderToStaticMarkup(React.createElement(AdminStepUpStatus, { visible: true }));

    expect(mockQueryOptions[0]?.enabled).toBe(true);
    expect(mockQueryOptions[0]?.refetchInterval).toBe(30_000);
  });
});
