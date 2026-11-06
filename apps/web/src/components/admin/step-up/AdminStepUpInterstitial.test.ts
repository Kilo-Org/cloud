jest.mock('@tanstack/react-query', () => ({
  useQuery: () => mockQueryState,
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    stepUp: { getStatus: { queryOptions: () => ({ queryKey: ['step-up-status'] }) } },
  }),
}));
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));
jest.mock('next/navigation', () => ({ usePathname: () => '/admin' }));

import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdminStepUpInterstitial as InterstitialComponent } from './AdminStepUpInterstitial';
import type { StepUpRequirement } from './step-up-error';

let AdminStepUpInterstitial!: typeof InterstitialComponent;

beforeAll(async () => {
  ({ AdminStepUpInterstitial } = await import('./AdminStepUpInterstitial'));
});

type QueryState = {
  isSuccess: boolean;
  isLoading: boolean;
  isError: boolean;
  data?: {
    enrolled: boolean;
    sessionBound: boolean;
    unavailable?: boolean;
  };
  refetch?: jest.Mock;
};

let mockQueryState: QueryState;

function render(requirement: StepUpRequirement): string {
  return renderToStaticMarkup(React.createElement(AdminStepUpInterstitial, { requirement }));
}

describe('AdminStepUpInterstitial', () => {
  it('renders while the passkey status is loading', () => {
    mockQueryState = { isSuccess: false, isLoading: true, isError: false };
    const html = render({ code: 'MFA_REQUIRED' });
    expect(html).toContain('Verify it is you');
    expect(html).toContain('Checking your passkeys');
  });

  it('offers enrollment for NOT_ENROLLED', () => {
    mockQueryState = {
      isSuccess: true,
      isLoading: false,
      isError: false,
      data: { enrolled: false, sessionBound: true },
    };
    expect(render({ code: 'NOT_ENROLLED' })).toContain('Add a passkey');
  });

  it('offers verification for MFA_REQUIRED', () => {
    mockQueryState = {
      isSuccess: true,
      isLoading: false,
      isError: false,
      data: { enrolled: true, sessionBound: true },
    };
    expect(render({ code: 'MFA_REQUIRED' })).toContain('Verify with passkey');
  });

  it('offers sign-in for SESSION_UNBOUND', () => {
    mockQueryState = {
      isSuccess: true,
      isLoading: false,
      isError: false,
      data: { enrolled: true, sessionBound: false },
    };
    expect(render({ code: 'SESSION_UNBOUND' })).toContain('Sign out and sign in again');
  });

  it('uses an h1 and page landmark variant when replacing the shell', () => {
    mockQueryState = {
      isSuccess: true,
      isLoading: false,
      isError: false,
      data: { enrolled: true, sessionBound: true },
    };
    const html = renderToStaticMarkup(
      React.createElement(AdminStepUpInterstitial, {
        requirement: { code: 'MFA_REQUIRED' },
        variant: 'page',
      })
    );
    expect(html).toContain('<h1');
  });

  it('shows a retry when the status read fails', () => {
    const refetch = jest.fn();
    mockQueryState = { isSuccess: false, isLoading: false, isError: true, refetch };
    const html = render({ code: 'MFA_REQUIRED' });
    expect(html).toContain('Could not check verification status');
    expect(html).toContain('Retry status check');
  });
});
