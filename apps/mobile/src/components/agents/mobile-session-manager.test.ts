import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { type UserWebConnection } from 'cloud-agent-sdk';

const mocks = vi.hoisted(() => ({
  createSessionManager: vi.fn(config => ({ config })),
  getWithRuntimeStateQuery: vi.fn(),
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

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  CLOUD_AGENT_WS_URL: 'wss://agent.example.com',
  WEB_BASE_URL: 'https://web.example.com',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: {
      getWithRuntimeState: { query: mocks.getWithRuntimeStateQuery },
    },
  },
}));

type CapturedSessionManagerConfig = {
  userWebConnection: unknown;
  cliWebsocketUrl?: string;
  getAuthToken?: () => Promise<string>;
  fetchSession: (kiloSessionId: string) => Promise<{ associatedPr: unknown }>;
};

describe('createMobileAgentSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
