import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const mocks = vi.hoisted(() => ({
  createSessionManager: vi.fn(config => ({ config })),
  getWithRuntimeStateQuery: vi.fn(),
}));

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
  SESSION_INGEST_WS_URL: 'wss://ingest.example.com',
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
  fetchSession: (kiloSessionId: string) => Promise<{ associatedPr: unknown }>;
};

describe('createMobileAgentSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    createMobileAgentSessionManager({ store: createStore() });

    const config = mocks.createSessionManager.mock.calls[0]?.[0] as CapturedSessionManagerConfig;
    const session = await config.fetchSession('ses_123');

    expect(session.associatedPr).toBe(associatedPr);
  });
});
