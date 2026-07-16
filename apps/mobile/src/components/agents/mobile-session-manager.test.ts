import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { type UserWebConnection } from 'cloud-agent-sdk';

const mocks = vi.hoisted(() => ({
  createSessionManager: vi.fn(config => ({ config })),
  createNativeUserWebConnectionLifecycleHooks: vi.fn(() => ({ marker: 'native-lifecycle-hooks' })),
  getWithRuntimeStateQuery: vi.fn(),
  getSessionQuery: vi.fn(),
  getSessionMessagesQuery: vi.fn(),
  sendMessageMutate: vi.fn(),
  prepareSessionMutate: vi.fn(),
}));

function noCleanup(): void {
  return undefined;
}

const userWebConnection: UserWebConnection = {
  retain: vi.fn(() => noCleanup),
  connect: vi.fn(() => undefined),
  disconnect: vi.fn(() => undefined),
  destroy: vi.fn(() => undefined),
  subscribeToCliSession: vi.fn(() => noCleanup),
  sendCommand: vi.fn(),
  onCliEvent: vi.fn(() => noCleanup),
  onSystemEvent: vi.fn(() => noCleanup),
  onReconnect: vi.fn(() => noCleanup),
  onSessionEvent: vi.fn(() => noCleanup),
};

vi.mock('cloud-agent-sdk', () => ({
  createSessionManager: mocks.createSessionManager,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/components/agents/mode-options', () => ({
  normalizeAgentMode: vi.fn(mode => mode),
}));

vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(() => null),
  withCloudAgentDiagnostics: vi.fn(
    async <T>(_operation: string, _organizationId: string | undefined, run: () => Promise<T>) => {
      const result = await run();
      return result;
    }
  ),
}));

vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: mocks.createNativeUserWebConnectionLifecycleHooks,
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  CLOUD_AGENT_WS_URL: 'wss://agent.example.com',
  WEB_BASE_URL: 'https://web.example.com',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: {
      get: { query: mocks.getSessionQuery },
      getSessionMessages: { query: mocks.getSessionMessagesQuery },
      getWithRuntimeState: { query: mocks.getWithRuntimeStateQuery },
    },
    activeSessions: {
      list: { query: vi.fn() },
    },
    cloudAgentNext: {
      sendMessage: { mutate: mocks.sendMessageMutate },
      prepareSession: { mutate: mocks.prepareSessionMutate },
    },
    organizations: {
      cloudAgentNext: {
        sendMessage: { mutate: mocks.sendMessageMutate },
        prepareSession: { mutate: mocks.prepareSessionMutate },
      },
    },
  },
}));

type CapturedSessionManagerConfig = {
  userWebConnection: unknown;
  cliWebsocketUrl?: string;
  getAuthToken?: () => Promise<string>;
  lifecycleHooks?: unknown;
  fetchSession: (kiloSessionId: string) => Promise<{ associatedPr: unknown }>;
  fetchSnapshot: (kiloSessionId: string) => Promise<{ info: unknown; messages: unknown[] }>;
  fetchSnapshotPage: (kiloSessionId: string, options: { cursor?: string }) => Promise<unknown>;
  prepare: (input: {
    prompt: string;
    mode: string;
    model: string;
    initialPayload?: unknown;
  }) => Promise<unknown>;
};

describe('createMobileAgentSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareSessionMutate.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_123',
    });
  });

  it('injects the app-scoped user web connection without raw viewer transport options', async () => {
    const { createMobileAgentSessionManager } =
      await import('@/components/agents/mobile-session-manager');

    createMobileAgentSessionManager({
      store: createStore(),
      userWebConnection,
    });

    const config = mocks.createSessionManager.mock.calls[0]?.[0] as CapturedSessionManagerConfig;
    expect(config.userWebConnection).toBe(userWebConnection);
    expect(config.cliWebsocketUrl).toBeUndefined();
    expect(config.getAuthToken).toBeUndefined();
  });

  it('passes native lifecycle hooks to Cloud Agent stream connections', async () => {
    const { createMobileAgentSessionManager } =
      await import('@/components/agents/mobile-session-manager');

    createMobileAgentSessionManager({
      store: createStore(),
      userWebConnection,
    });

    const config = mocks.createSessionManager.mock.calls[0]?.[0] as CapturedSessionManagerConfig;
    expect(mocks.createNativeUserWebConnectionLifecycleHooks).toHaveBeenCalledTimes(1);
    expect(config.lifecycleHooks).toEqual({ marker: 'native-lifecycle-hooks' });
  });

  it('converts an initial Kilo model ref to the Cloud Agent prepare payload', async () => {
    const { createMobileAgentSessionManager } =
      await import('@/components/agents/mobile-session-manager');

    createMobileAgentSessionManager({
      store: createStore(),
      userWebConnection,
    });

    const config = mocks.createSessionManager.mock.calls[0]?.[0] as CapturedSessionManagerConfig;
    await config.prepare({
      prompt: 'Initial prompt',
      mode: 'code',
      model: 'fallback-model',
      initialPayload: {
        type: 'prompt',
        prompt: 'Initial prompt',
        mode: 'code',
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
        variant: 'high',
      },
    });

    expect(mocks.prepareSessionMutate).toHaveBeenCalledWith(
      {
        prompt: 'Initial prompt',
        mode: 'code',
        model: 'fallback-model',
        initialPayload: {
          type: 'prompt',
          prompt: 'Initial prompt',
          mode: 'code',
          model: 'anthropic/claude-sonnet-4',
          variant: 'high',
        },
      },
      { context: { skipBatch: true } }
    );
  });

  it('rejects a non-Kilo initial model ref before Cloud Agent prepare', async () => {
    const { createMobileAgentSessionManager } =
      await import('@/components/agents/mobile-session-manager');

    createMobileAgentSessionManager({
      store: createStore(),
      userWebConnection,
    });

    const config = mocks.createSessionManager.mock.calls[0]?.[0] as CapturedSessionManagerConfig;
    await expect(
      config.prepare({
        prompt: 'Initial prompt',
        mode: 'code',
        model: 'fallback-model',
        initialPayload: {
          type: 'prompt',
          prompt: 'Initial prompt',
          mode: 'code',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        },
      })
    ).rejects.toThrow('Cloud Agent only supports Kilo models');
    expect(mocks.prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('preserves snapshot model metadata from the session export', async () => {
    const { createMobileAgentSessionManager } =
      await import('@/components/agents/mobile-session-manager');
    mocks.getSessionQuery.mockResolvedValue({
      session_id: 'ses_123',
      parent_session_id: null,
    });
    mocks.getSessionMessagesQuery.mockResolvedValue({
      info: {
        id: 'ses_123',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4', variant: 'high' },
      },
      messages: [],
    });

    createMobileAgentSessionManager({
      store: createStore(),
      userWebConnection,
    });

    const config = mocks.createSessionManager.mock.calls[0]?.[0] as CapturedSessionManagerConfig;
    await expect(config.fetchSnapshot('ses_123')).resolves.toEqual({
      info: {
        id: 'ses_123',
        parentID: undefined,
        model: { providerID: 'anthropic', id: 'claude-sonnet-4', variant: 'high' },
      },
      messages: [],
    });
  });

  it('propagates associatedPr from fetched session data', async () => {
    const { createMobileAgentSessionManager } =
      await import('@/components/agents/mobile-session-manager');
    const associatedPr = {
      url: 'https://github.com/Kilo-Org/cloud/pull/3383',
      number: 3383,
      state: 'open',
      title: 'Refactor cloud agent session management',
      headSha: 'abc123',
      lastSyncedAt: '2026-05-22T20:00:00.000Z',
    };

    mocks.getWithRuntimeStateQuery.mockResolvedValue({
      cloud_agent_session_id: 'agent_123',
      title: 'Session title',
      organization_id: null,
      git_url: 'https://github.com/Kilo-Org/cloud.git',
      git_branch: 'feature/pr',
      associatedPr,
      runtimeState: null,
    });

    createMobileAgentSessionManager({
      store: createStore(),
      userWebConnection,
    });

    const config = mocks.createSessionManager.mock.calls[0]?.[0] as CapturedSessionManagerConfig;
    const session = await config.fetchSession('ses_123');

    expect(session.associatedPr).toBe(associatedPr);
  });
});
