import { describe, it, expect, vi } from 'vitest';

vi.mock('./agent-runner', () => ({
  runAgent: vi.fn(),
  resolveGitCredentials: vi.fn(),
  writeMayorSystemPromptToAgentsMd: vi.fn(),
}));

vi.mock('./process-manager', () => ({
  stopAgent: vi.fn(),
  sendMessage: vi.fn(),
  updateAgentModel: vi.fn(),
  getAgentStatus: vi.fn(),
  activeAgentCount: vi.fn(() => 0),
  activeServerCount: vi.fn(() => 0),
  getUptime: vi.fn(() => 0),
  getStartTime: vi.fn(() => '2026-01-01T00:00:00.000Z'),
  getMayorReadyAt: vi.fn(() => null),
  stopAll: vi.fn(),
  drainAll: vi.fn(),
  isDraining: vi.fn(() => false),
  getAgentEvents: vi.fn(),
  registerEventSink: vi.fn(),
  refreshTokenForAllAgents: vi.fn(),
  listAgents: vi.fn(() => []),
  awaitHydration: vi.fn(),
}));

vi.mock('./logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./heartbeat', () => ({
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
  notifyContainerReady: vi.fn(),
}));

vi.mock('./dashboard-context', () => ({
  pushContext: vi.fn(),
}));

vi.mock('./git-manager', () => ({
  mergeBranch: vi.fn(),
  setupRigBrowseWorktree: vi.fn(),
}));

const { app } = await import('./control-server');

describe('/sync-config', () => {
  it('preserves startup GASTOWN_API_URL when the sync payload omits it', async () => {
    const previousApiUrl = process.env.GASTOWN_API_URL;
    const previousToken = process.env.KILOCODE_TOKEN;
    const previousGitToken = process.env.GIT_TOKEN;
    process.env.GASTOWN_API_URL = 'https://startup.example.com';
    process.env.KILOCODE_TOKEN = 'old-token';

    try {
      const response = await app.request('/sync-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envVars: { GIT_TOKEN: 'new-token' } }),
      });

      expect(response.status).toBe(200);
      expect(process.env.GASTOWN_API_URL).toBe('https://startup.example.com');
      expect(process.env.KILOCODE_TOKEN).toBeUndefined();
      expect(process.env.GIT_TOKEN).toBe('new-token');
    } finally {
      if (previousApiUrl !== undefined) process.env.GASTOWN_API_URL = previousApiUrl;
      else delete process.env.GASTOWN_API_URL;

      if (previousToken !== undefined) process.env.KILOCODE_TOKEN = previousToken;
      else delete process.env.KILOCODE_TOKEN;

      if (previousGitToken !== undefined) process.env.GIT_TOKEN = previousGitToken;
      else delete process.env.GIT_TOKEN;
    }
  });
});
