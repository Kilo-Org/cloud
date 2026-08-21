import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateAllSecurityLifecycleScopes,
  invalidateSecurityLifecycleScope,
  subscribeToSecurityLifecycleInvalidation,
} from './use-security-lifecycle-invalidation';
import type * as SecurityAgentCommandsModule from './use-security-agent-commands';

const mocks = vi.hoisted(() => ({
  addNotificationReceivedListener: vi.fn(),
  appStateAddEventListener: vi.fn(),
  onlineSubscribe: vi.fn(),
  parseNotificationData: vi.fn(),
  reconcileFirstPage: vi.fn(),
  scheduleCacheMaintenance: vi.fn((run: () => void) => {
    run();
  }),
  invalidateSecurityAgentCommandObserver: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  addNotificationReceivedListener: mocks.addNotificationReceivedListener,
}));

vi.mock('@tanstack/react-query', () => ({
  onlineManager: { subscribe: mocks.onlineSubscribe },
  useQueryClient: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: mocks.appStateAddEventListener },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({}),
}));

vi.mock('@/lib/notifications', () => ({
  parseNotificationData: mocks.parseNotificationData,
}));

vi.mock('@/lib/query/infinite-retention', () => ({
  reconcileFirstPage: mocks.reconcileFirstPage,
}));

vi.mock('@/lib/query/schedule-cache-maintenance', () => ({
  scheduleCacheMaintenance: mocks.scheduleCacheMaintenance,
}));

vi.mock('@/lib/hooks/use-security-agent-commands', async importOriginal => {
  const actual = await importOriginal<typeof SecurityAgentCommandsModule>();
  return {
    ...actual,
    invalidateSecurityAgentCommandObserver: mocks.invalidateSecurityAgentCommandObserver,
  };
});

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

type OrgKey = (input?: { organizationId: string }) => unknown[];

type TrpcStub = {
  securityAgent: {
    listFindings: { queryKey: () => string[] };
    getFinding: { queryKey: () => string[] };
    getAnalysis: { queryKey: () => string[] };
    getCommandStatuses: { queryKey: () => string[] };
    listActiveCommands: { queryKey: () => string[] };
  };
  organizations: {
    securityAgent: {
      listFindings: { queryKey: OrgKey };
      getFinding: { queryKey: OrgKey };
      getAnalysis: { queryKey: OrgKey };
      getCommandStatuses: { queryKey: () => string[] };
      listActiveCommands: { queryKey: () => string[] };
    };
  };
};

function orgKey(name: string): OrgKey {
  return input =>
    input
      ? ['organizations', 'securityAgent', name, input]
      : ['organizations', 'securityAgent', name];
}

function makeTrpcStub(): TrpcStub {
  return {
    securityAgent: {
      listFindings: { queryKey: () => ['securityAgent', 'listFindings'] },
      getFinding: { queryKey: () => ['securityAgent', 'getFinding'] },
      getAnalysis: { queryKey: () => ['securityAgent', 'getAnalysis'] },
      getCommandStatuses: { queryKey: () => ['securityAgent', 'getCommandStatuses'] },
      listActiveCommands: { queryKey: () => ['securityAgent', 'listActiveCommands'] },
    },
    organizations: {
      securityAgent: {
        listFindings: { queryKey: orgKey('listFindings') },
        getFinding: { queryKey: orgKey('getFinding') },
        getAnalysis: { queryKey: orgKey('getAnalysis') },
        getCommandStatuses: {
          queryKey: () => ['organizations', 'securityAgent', 'getCommandStatuses'],
        },
        listActiveCommands: {
          queryKey: () => ['organizations', 'securityAgent', 'listActiveCommands'],
        },
      },
    },
  };
}

function makeQueryClient() {
  return { invalidateQueries: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.addNotificationReceivedListener.mockReset();
  mocks.appStateAddEventListener.mockReset();
  mocks.onlineSubscribe.mockReset();
  mocks.parseNotificationData.mockReset();
});

describe('invalidateSecurityLifecycleScope', () => {
  it.each([
    {
      scope: 'personal',
      findingsKey: ['securityAgent', 'listFindings'],
      findingKey: ['securityAgent', 'getFinding'],
      analysisKey: ['securityAgent', 'getAnalysis'],
    },
    {
      scope: 'org_1',
      findingsKey: ['organizations', 'securityAgent', 'listFindings', { organizationId: 'org_1' }],
      findingKey: ['organizations', 'securityAgent', 'getFinding', { organizationId: 'org_1' }],
      analysisKey: ['organizations', 'securityAgent', 'getAnalysis', { organizationId: 'org_1' }],
    },
  ])(
    'invalidates the $scope findings, finding-details, analysis, and command-status queries',
    ({ scope, findingsKey, findingKey, analysisKey }) => {
      const trpc = makeTrpcStub();
      const queryClient = makeQueryClient();
      const deps = { trpc, queryClient };

      invalidateSecurityLifecycleScope(deps as never, scope);

      expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, findingsKey);
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: findingKey });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: analysisKey });
      expect(mocks.invalidateSecurityAgentCommandObserver).toHaveBeenCalledWith(
        queryClient,
        trpc,
        scope
      );
    }
  );
});

describe('invalidateAllSecurityLifecycleScopes', () => {
  it('invalidates the personal and organization families with no scope', () => {
    const trpc = makeTrpcStub();
    const queryClient = makeQueryClient();
    const deps = { trpc, queryClient };

    invalidateAllSecurityLifecycleScopes(deps as never);

    expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, [
      'securityAgent',
      'listFindings',
    ]);
    expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, [
      'organizations',
      'securityAgent',
      'listFindings',
    ]);

    for (const queryKey of [
      ['securityAgent', 'getFinding'],
      ['securityAgent', 'getAnalysis'],
      ['securityAgent', 'getCommandStatuses'],
      ['securityAgent', 'listActiveCommands'],
      ['organizations', 'securityAgent', 'getFinding'],
      ['organizations', 'securityAgent', 'getAnalysis'],
      ['organizations', 'securityAgent', 'getCommandStatuses'],
      ['organizations', 'securityAgent', 'listActiveCommands'],
    ]) {
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });
});

describe('subscribeToSecurityLifecycleInvalidation', () => {
  type ReceivedListener = (notification: { request: { content: { data: unknown } } }) => void;
  type AppStateListener = (state: string) => void;
  type OnlineListener = (online: boolean) => void;

  function captureListeners() {
    let receivedListener: ReceivedListener | undefined = undefined;
    let appStateListener: AppStateListener | undefined = undefined;
    let onlineListener: OnlineListener | undefined = undefined;

    mocks.addNotificationReceivedListener.mockImplementation((listener: ReceivedListener) => {
      receivedListener = listener;
      return { remove: vi.fn() };
    });
    mocks.appStateAddEventListener.mockImplementation(
      (_event: string, listener: AppStateListener) => {
        appStateListener = listener;
        return { remove: vi.fn() };
      }
    );
    mocks.onlineSubscribe.mockImplementation((listener: OnlineListener) => {
      onlineListener = listener;
      return vi.fn();
    });

    return {
      received: (data: unknown) => {
        receivedListener?.({ request: { content: { data } } });
      },
      appState: (state: string) => {
        appStateListener?.(state);
      },
      online: (online: boolean) => {
        onlineListener?.(online);
      },
    };
  }

  it('invalidates the affected scope on a foreground security_lifecycle receipt', () => {
    const trpc = makeTrpcStub();
    const queryClient = makeQueryClient();
    const deps = { trpc, queryClient };
    const listeners = captureListeners();

    subscribeToSecurityLifecycleInvalidation(deps as never);

    mocks.parseNotificationData.mockReturnValue({
      type: 'security_lifecycle',
      event: 'analysis_completed',
      findingId: 'f-1',
      scope: 'org_9',
    });
    listeners.received({ type: 'security_lifecycle' });

    expect(mocks.invalidateSecurityAgentCommandObserver).toHaveBeenCalledWith(
      queryClient,
      trpc,
      'org_9'
    );
    expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, [
      'organizations',
      'securityAgent',
      'listFindings',
      { organizationId: 'org_9' },
    ]);
  });

  it('drops an unparseable or non-lifecycle payload without invalidating', () => {
    const trpc = makeTrpcStub();
    const queryClient = makeQueryClient();
    const deps = { trpc, queryClient };
    const listeners = captureListeners();

    subscribeToSecurityLifecycleInvalidation(deps as never);

    // Unknown event value: Zod parse returns null.
    mocks.parseNotificationData.mockReturnValue(null);
    listeners.received({ type: 'security_lifecycle', event: 'sla_warning' });
    expect(mocks.invalidateSecurityAgentCommandObserver).not.toHaveBeenCalled();

    // A visible finding push is not a lifecycle event.
    mocks.parseNotificationData.mockReturnValue({
      type: 'security_finding',
      findingId: 'f-1',
      scope: 'personal',
    });
    listeners.received({ type: 'security_finding' });
    expect(mocks.invalidateSecurityAgentCommandObserver).not.toHaveBeenCalled();
  });

  it('invalidates every family on AppState active and on reconnect', () => {
    const trpc = makeTrpcStub();
    const queryClient = makeQueryClient();
    const deps = { trpc, queryClient };
    const listeners = captureListeners();

    subscribeToSecurityLifecycleInvalidation(deps as never);

    listeners.appState('active');
    expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, [
      'securityAgent',
      'listFindings',
    ]);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['securityAgent', 'getCommandStatuses'],
    });

    mocks.reconcileFirstPage.mockClear();
    queryClient.invalidateQueries.mockClear();

    listeners.online(true);
    expect(mocks.reconcileFirstPage).toHaveBeenCalledWith(queryClient, [
      'securityAgent',
      'listFindings',
    ]);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['securityAgent', 'getCommandStatuses'],
    });

    // Offline is not a recovery source.
    mocks.reconcileFirstPage.mockClear();
    queryClient.invalidateQueries.mockClear();
    listeners.online(false);
    expect(mocks.reconcileFirstPage).not.toHaveBeenCalled();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('removes all three subscriptions on cleanup', () => {
    const removeNotification = vi.fn();
    const removeAppState = vi.fn();
    const removeOnline = vi.fn();

    mocks.addNotificationReceivedListener.mockReturnValue({ remove: removeNotification });
    mocks.appStateAddEventListener.mockReturnValue({ remove: removeAppState });
    mocks.onlineSubscribe.mockReturnValue(removeOnline);

    const trpc = makeTrpcStub();
    const queryClient = makeQueryClient();
    const cleanup = subscribeToSecurityLifecycleInvalidation({
      trpc: trpc as never,
      queryClient: queryClient as never,
    });

    cleanup();

    expect(removeNotification).toHaveBeenCalled();
    expect(removeAppState).toHaveBeenCalled();
    expect(removeOnline).toHaveBeenCalled();
  });
});
