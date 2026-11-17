/**
 * @jest-environment node
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as ReactQueryModule from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { OrganizationWithMembersResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import type * as SSOSignupCardModule from './SSOSignupCard';

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: {
      sso: {
        getConfig: { queryOptions: () => ({}) },
        generateAdminPortalLink: { mutationOptions: () => ({}) },
      },
    },
  }),
}));

jest.mock('posthog-js/react', () => ({ usePostHog: () => null }));
jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked module and the module under test are required here.
const { useQuery } = jest.requireMock<typeof ReactQueryModule>('@tanstack/react-query');
const mockUseQuery = jest.mocked(useQuery);

const organization = {
  id: 'a4f1c2d3-0000-4000-8000-9a1b2c3d4e01',
  name: 'Enterprise lab',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  microdollars_used: 0,
  total_microdollars_acquired: 0,
  next_credit_expiration_at: null,
  stripe_customer_id: null,
  auto_top_up_enabled: false,
  settings: {},
  seat_count: 3,
  require_seats: false,
  created_by_kilo_user_id: null,
  deleted_at: null,
  sso_domain: null,
  parent_organization_id: null,
  plan: 'enterprise',
  free_trial_end_at: '2099-01-01T00:00:00.000Z',
  company_domain: null,
  callerRole: 'owner',
  members: [],
  childOrganizations: [],
  effectiveSsoPolicy: { required: false, source: null, domain: null, configurationError: false },
} satisfies OrganizationWithMembersResponse;

const previousReact = Reflect.get(globalThis, 'React');
let SSOSignupCard: typeof SSOSignupCardModule.SSOSignupCard;

beforeAll(() => {
  Object.assign(globalThis, { React });
  ({ SSOSignupCard } = jest.requireActual<typeof SSOSignupCardModule>('./SSOSignupCard'));
});

afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});

beforeEach(() => {
  mockUseQuery.mockReset();
});

function setStatusQuery(state: { data?: unknown; isLoading?: boolean; error?: unknown }) {
  mockUseQuery.mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: state.error ?? null,
    refetch: jest.fn(),
  } as unknown as UseQueryResult);
}

function render(shell: boolean) {
  return renderToStaticMarkup(
    createElement(SSOSignupCard, { organization, role: 'owner' as const, shell })
  );
}

describe('SSOSignupCard', () => {
  it('states a failed status read on a shell page instead of leaving it blank', () => {
    setStatusQuery({ isLoading: false, error: new Error('status read failed') });

    const markup = render(true);

    expect(markup).toContain('Could not load SSO settings');
    expect(markup).toContain('Try again');
  });

  it('stays hidden on the dashboard when its own status read fails', () => {
    setStatusQuery({ isLoading: false, error: new Error('status read failed') });

    expect(render(false)).toBe('');
  });

  it('reserves the card on a shell page while the status read settles', () => {
    setStatusQuery({ isLoading: true });

    expect(render(true)).toContain('data-slot="skeleton"');
  });

  it('shows the setup content, without a link off the shell, when no SSO is configured', () => {
    setStatusQuery({ isLoading: false, data: false });

    const markup = render(true);

    expect(markup).toContain('Single Sign-On (SSO)');
    expect(markup).toContain('SSO is not configured for this organization.');
    expect(markup).not.toContain('kilo.ai/setup-sso');
  });
});
