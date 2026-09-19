import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLiveSessionManager } from '@/components/agents/live-session-manager-registry';
import { renderWithProviders } from '@/test/render-with-providers';
import { act } from '@/test/renderer';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
  markRestoredAuthenticatedOwner,
} from '@/lib/context-scope';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';

import { AgentSessionProvider } from './session-provider';

type ManagerFactoryOptions = { store: unknown; userId: string; organizationId?: string };

const mocks = vi.hoisted(() => {
  const manager = {
    label: 'manager',
    destroy: vi.fn(),
    respondToPermission: vi.fn(),
    switchSession: vi.fn(),
  };
  // The route params the provider reads; a holder so each case can swap them.
  const route: { params: Record<string, string | string[] | undefined> } = { params: {} };
  return {
    route,
    manager,
    connection: { label: 'connection' },
    createManager: vi.fn((_options: ManagerFactoryOptions) => manager),
  };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => mocks.route.params,
}));

vi.mock('@/components/agents/mobile-session-manager', () => ({
  createMobileAgentSessionManager: mocks.createManager,
}));

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => mocks.connection,
}));

type RouteParams = Record<string, string | string[] | undefined>;

/** Each case names an id it must not find registered under. */
const noSingleSessionIdCases: readonly [RouteParams, string][] = [
  [{}, 'provider-session-none'],
  [
    { 'session-id': ['provider-session-multi-a', 'provider-session-multi-b'] },
    'provider-session-multi-a',
  ],
  [{ 'session-id': '' }, 'provider-session-empty'],
];

describe('AgentSessionProvider live manager registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.route.params = {};
    setSignOutActive(false);
    beginAuthenticatedOwner();
    confirmAuthenticatedOwner(getAuthenticatedOwner(), 'user-1');
  });

  it('keeps a restored manager alive through same-account confirmation', async () => {
    beginAuthenticatedOwner();
    markRestoredAuthenticatedOwner();
    mocks.route.params = { 'session-id': 'provider-restored' };
    const { unmount } = await renderWithProviders(
      <AgentSessionProvider restoredUserId="user-1">{null}</AgentSessionProvider>
    );
    expect(mocks.createManager).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
    expect(mocks.manager.destroy).not.toHaveBeenCalled();
    act(() => {
      confirmAuthenticatedOwner(getAuthenticatedOwner(), 'user-1');
    });
    expect(mocks.createManager).toHaveBeenCalledTimes(1);
    expect(mocks.manager.destroy).not.toHaveBeenCalled();
    unmount();
    expect(mocks.manager.destroy).toHaveBeenCalledTimes(1);
    expect(getLiveSessionManager('provider-restored')).toBeNull();
  });

  it.each(['generation', 'epoch', 'sign-out'] as const)(
    'retires a restored manager on %s revocation before unmount',
    async revocation => {
      beginAuthenticatedOwner();
      markRestoredAuthenticatedOwner();
      const { unmount } = await renderWithProviders(
        <AgentSessionProvider restoredUserId="user-1">{null}</AgentSessionProvider>
      );
      expect(mocks.manager.destroy).not.toHaveBeenCalled();
      act(() => {
        if (revocation === 'epoch') {
          bumpAuthEpoch();
          markRestoredAuthenticatedOwner();
        } else {
          if (revocation === 'sign-out') {
            setSignOutActive(true);
          }
          beginAuthenticatedOwner();
        }
      });
      expect(mocks.manager.destroy).toHaveBeenCalledTimes(1);
      unmount();
    }
  );

  it('retires a manager that has no confirmed or restored scope', async () => {
    beginAuthenticatedOwner();
    const { unmount } = await renderWithProviders(createElement(AgentSessionProvider, null, null));
    expect(mocks.createManager).toHaveBeenCalledWith(expect.objectContaining({ userId: '' }));
    expect(mocks.manager.destroy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('registers the open session manager under the route session id', async () => {
    mocks.route.params = { 'session-id': 'provider-session-a' };

    const { unmount } = await renderWithProviders(createElement(AgentSessionProvider, null, null));

    expect(mocks.createManager).toHaveBeenCalledTimes(1);
    const options = mocks.createManager.mock.calls[0]?.[0];
    const registered = getLiveSessionManager('provider-session-a');
    expect(registered?.manager).toBe(mocks.manager);
    // The store must travel with the manager: the orchestrator reads the
    // manager's atoms through the store it was created with.
    expect(registered?.store).toBe(options?.store);

    unmount();
  });

  it('unregisters the manager when the screen unmounts', async () => {
    mocks.route.params = { 'session-id': 'provider-session-b' };
    const { unmount } = await renderWithProviders(createElement(AgentSessionProvider, null, null));
    expect(getLiveSessionManager('provider-session-b')).not.toBeNull();

    unmount();

    expect(getLiveSessionManager('provider-session-b')).toBeNull();
  });

  it.each(noSingleSessionIdCases)(
    'registers nothing without a single route session id %j',
    async (params, id) => {
      mocks.route.params = params;

      const { unmount } = await renderWithProviders(
        createElement(AgentSessionProvider, null, null)
      );

      expect(getLiveSessionManager(id)).toBeNull();
      unmount();
    }
  );
});
