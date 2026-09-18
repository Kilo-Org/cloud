import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLiveSessionManager } from '@/components/agents/live-session-manager-registry';
import { renderWithProviders } from '@/test/render-with-providers';

import { AgentSessionProvider } from './session-provider';

type ManagerFactoryOptions = { store: unknown; organizationId?: string };

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

vi.mock('@/lib/context-scope', () => ({
  getAuthenticatedOwner: () => ({ authEpoch: 0, generation: 0, userId: 'user-1' }),
  isAuthenticatedOwner: () => true,
  subscribeAuthenticatedOwner: () => () => undefined,
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
