/* eslint-disable id-length, jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- WXT virtual module and heavy view layer are replaced by fakes */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { createElement as h } from 'react';
import type { StoredAuth } from '@/src/shared/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeSessionsQueryKey,
  cliInstancesQueryKey,
  sessionRepositoriesQueryKey,
} from '@/src/shared/side-panel-query-options';
import { App } from './app';

const ALPHA_AUTH: StoredAuth = { token: 'token-a', userEmail: 'first@example.test' };
const BETA_AUTH: StoredAuth = { token: 'token-b', userEmail: 'second@example.test' };

const authMocks = vi.hoisted(() => ({
  clearStoredSession: vi.fn<(storage: unknown) => Promise<void>>(),
  createDeviceAuthRequest: vi.fn<() => Promise<unknown>>(),
  loadStoredAuth: vi.fn<() => Promise<unknown>>(),
  persistApprovedDeviceAuth: vi.fn<(storage: unknown, auth: unknown) => Promise<unknown>>(),
  pollDeviceAuthCode: vi.fn<() => Promise<unknown>>(),
  resetAnalyticsUser: vi.fn<() => Promise<void>>(),
  saveStoredAuth: vi.fn<(storage: unknown, auth: unknown) => Promise<void>>(),
  validateAuthToken: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('#imports', () => ({
  browser: { tabs: { create: vi.fn(async () => {}) } },
  storage: { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() },
}));

vi.mock('@/src/shared/auth', () => ({
  clearStoredSession: (storage: unknown) => authMocks.clearStoredSession(storage),
  createDeviceAuthRequest: () => authMocks.createDeviceAuthRequest(),
  getKiloApiBaseUrl: () => 'https://app.kilo.test',
  loadStoredAuth: () => authMocks.loadStoredAuth(),
  pollDeviceAuthCode: () => authMocks.pollDeviceAuthCode(),
  saveStoredAuth: (storage: unknown, auth: unknown) => authMocks.saveStoredAuth(storage, auth),
  validateAuthToken: () => authMocks.validateAuthToken(),
}));

vi.mock('@/src/shared/device-auth-approval', () => ({
  persistApprovedDeviceAuth: (storage: unknown, auth: unknown) =>
    authMocks.persistApprovedDeviceAuth(storage, auth),
}));

vi.mock('@/src/shared/analytics', () => ({
  resetAnalyticsUser: () => authMocks.resetAnalyticsUser(),
}));

vi.mock('./use-analytics-identity', () => ({
  useAnalyticsIdentity: () => {},
}));

vi.mock('./agent-chat-atoms', () => ({
  clearPerConversationAtoms: () => {},
}));

vi.mock('./auth-views', () => ({
  LoadingView: () => h('div', null, 'loading'),
  PendingView: () => h('div', null, 'pending'),
  SignedInView: ({ auth, onSignOut }: { auth: StoredAuth; onSignOut: () => void }) =>
    h(
      'div',
      null,
      h('span', null, auth.userEmail ?? 'unknown'),
      h('button', { onClick: onSignOut, type: 'button' }, 'Sign out')
    ),
  SignedOutView: ({
    message,
    onSignIn,
  }: {
    isStarting: boolean;
    message?: string;
    onSignIn: () => void;
  }) =>
    h(
      'div',
      null,
      h('span', null, message ?? 'signed out'),
      h('button', { onClick: onSignIn, type: 'button' }, 'Sign in')
    ),
  ValidationErrorView: () => h('div', null, 'validation error'),
}));

const seedAgentsCache = (queryClient: QueryClient, auth: StoredAuth): void => {
  queryClient.setQueryData(activeSessionsQueryKey({ organizationId: null, token: auth.token }), {
    sessions: [{ id: 'seeded-session' }],
  });
  queryClient.setQueryData(
    sessionRepositoriesQueryKey({ organizationId: null, token: auth.token }),
    {
      repositories: [{ fullName: 'seeded/repo', id: 1, name: 'repo', private: true }],
    }
  );
  queryClient.setQueryData(cliInstancesQueryKey({ token: auth.token }), { instances: [] });
};

const agentsEntriesFor = (queryClient: QueryClient, auth: StoredAuth): unknown[] => [
  queryClient.getQueryData(activeSessionsQueryKey({ organizationId: null, token: auth.token })),
  queryClient.getQueryData(
    sessionRepositoriesQueryKey({ organizationId: null, token: auth.token })
  ),
  queryClient.getQueryData(cliInstancesQueryKey({ token: auth.token })),
];

const renderApp = (queryClient: QueryClient) =>
  render(h(QueryClientProvider, { client: queryClient }, h(App)));

const makeQueryClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });

describe('side panel identity transitions clear the agents cache', () => {
  // eslint-disable-next-line jest/no-hooks -- module mocks need a clean slate per test
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.clearStoredSession.mockResolvedValue();
    authMocks.loadStoredAuth.mockResolvedValue(ALPHA_AUTH);
    authMocks.resetAnalyticsUser.mockResolvedValue();
    authMocks.saveStoredAuth.mockResolvedValue();
    authMocks.validateAuthToken.mockResolvedValue({ auth: ALPHA_AUTH, status: 'valid' });
  });

  it('clears the agents cache on explicit sign out', async () => {
    const queryClient = makeQueryClient();
    seedAgentsCache(queryClient, ALPHA_AUTH);
    queryClient.setQueryData(['side-panel', 'tabs'], [{ title: 'kept' }]);

    const { getByText } = renderApp(queryClient);
    await waitFor(() => {
      expect(getByText('first@example.test')).toBeTruthy();
    });

    fireEvent.click(getByText('Sign out'));

    await waitFor(() => {
      expect(getByText('signed out')).toBeTruthy();
    });
    expect(agentsEntriesFor(queryClient, ALPHA_AUTH)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(queryClient.getQueryData(['side-panel', 'tabs'])).toStrictEqual([{ title: 'kept' }]);
  });

  it('clears the agents cache when the stored session is rejected', async () => {
    authMocks.validateAuthToken.mockResolvedValue({ status: 'invalid' });
    const queryClient = makeQueryClient();
    seedAgentsCache(queryClient, ALPHA_AUTH);

    const { getByText } = renderApp(queryClient);

    await waitFor(() => {
      expect(getByText('Your session expired. Sign in again.')).toBeTruthy();
    });
    expect(agentsEntriesFor(queryClient, ALPHA_AUTH)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('clears the agents cache on device-auth sign-in', async () => {
    authMocks.loadStoredAuth.mockResolvedValue(null);
    authMocks.createDeviceAuthRequest.mockResolvedValue({
      code: 'ABCD-2345',
      verificationUrl: 'https://app.kilo.test/device-auth',
    });
    authMocks.pollDeviceAuthCode.mockResolvedValue({ auth: BETA_AUTH, status: 'approved' });
    authMocks.persistApprovedDeviceAuth.mockResolvedValue({
      auth: BETA_AUTH,
      status: 'signedIn',
    });

    const queryClient = makeQueryClient();
    seedAgentsCache(queryClient, ALPHA_AUTH);

    const { getByText } = renderApp(queryClient);
    await waitFor(() => {
      expect(getByText('Sign in')).toBeTruthy();
    });

    fireEvent.click(getByText('Sign in'));

    await waitFor(() => {
      expect(getByText('second@example.test')).toBeTruthy();
    });
    expect(agentsEntriesFor(queryClient, ALPHA_AUTH)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(queryClient.getQueryData(['side-panel', 'stored-auth'])).toStrictEqual(BETA_AUTH);
  });
});
