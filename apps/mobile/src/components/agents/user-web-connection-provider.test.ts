/* eslint-disable typescript-eslint/no-deprecated, react/no-children-prop -- the .ts fixture uses react-test-renderer without JSX. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { setActiveToken } from '@/lib/auth/token-owner';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import { UserWebConnectionProvider } from './user-web-connection-provider';

type AuthConfig = { getAuthToken: () => Promise<string> };
const mocks = vi.hoisted(() => ({
  mutate: vi.fn<() => Promise<{ token: string; expiresAt: number }>>(),
  query: vi.fn(),
  capturedConfig: null as AuthConfig | null,
}));

vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn() }));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({
    token: 'account-a-token',
    isLoading: false,
    isSigningOut: false,
    sessionEnded: false,
  }),
}));
vi.mock('@kilocode/cloud-agent-sdk/user-web-connection', () => ({
  createUserWebConnection: (config: AuthConfig) => {
    mocks.capturedConfig = config;
    return { retain: () => vi.fn(), destroy: vi.fn() };
  },
}));
vi.mock('@/lib/config', () => ({ SESSION_INGEST_WS_URL: 'wss://ingest.example.com' }));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => ({}),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: { getMe: { query: vi.fn().mockResolvedValue({ id: 'user-a' }) } },
    activeSessions: {
      createWebTicket: { mutate: mocks.mutate },
      getToken: { query: mocks.query },
    },
  },
}));

async function mountTicketProducer() {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    holder.renderer = TestRenderer.create(
      createElement(UserWebConnectionProvider, { children: null })
    );
    await Promise.resolve();
  });
  onTestFinished(() => {
    act(() => holder.renderer?.unmount());
  });
  if (!mocks.capturedConfig) {
    throw new Error('createUserWebConnection was not called');
  }
  return mocks.capturedConfig;
}

describe('UserWebConnectionProvider ticket fencing', () => {
  beforeEach(() => {
    setSignOutActive(false);
    bumpAuthEpoch();
    beginAuthenticatedOwner();
    setActiveToken('account-a-token', null);
    mocks.capturedConfig = null;
    mocks.mutate.mockReset().mockResolvedValue({ token: 'ticket-1', expiresAt: 1_700_000_060 });
    mocks.query.mockClear();
  });

  it('mints the ingest ticket via the createWebTicket mutation (not the getToken query)', async () => {
    const config = await mountTicketProducer();
    const token = await config.getAuthToken();

    expect(token).toBe('ticket-1');
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects rather than returns a ticket completed under a retired generation', async () => {
    const ticket = Promise.withResolvers<{ token: string; expiresAt: number }>();
    mocks.mutate.mockReturnValueOnce(ticket.promise);
    const config = await mountTicketProducer();
    const result = config.getAuthToken();
    const rejection = expect(result).rejects.toThrow('Authenticated owner changed');
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      setSignOutActive(true);
      bumpAuthEpoch();
      beginAuthenticatedOwner();
      setActiveToken('account-b-token', null);
      setSignOutActive(false);
      confirmAuthenticatedOwner(getAuthenticatedOwner(), 'user-b');
    });
    ticket.resolve({ token: 'retired-ticket', expiresAt: 1_700_000_060 });

    await rejection;
    await expect(config.getAuthToken()).rejects.toThrow('Authenticated owner changed');
  });
});
