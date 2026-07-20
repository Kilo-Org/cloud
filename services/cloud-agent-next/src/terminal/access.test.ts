import { describe, expect, it, vi } from 'vitest';
import { AgentSandboxUnavailableError, type AgentSandbox } from '../agent-sandbox/protocol.js';
import type { CloudAgentSessionState } from '../persistence/types.js';
import type { Env } from '../types.js';
import { resolveTerminalWrapperClient, validateTerminalMetadata } from './access.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

const baseMetadata = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    userId: 'user-1',
    createdOnPlatform: 'cloud-agent-web',
  },
  auth: {},
  workspace: {
    workspacePath: '/workspace/repo',
  },
  lifecycle: {
    version: 1,
    timestamp: 1,
    preparedAt: 1,
  },
} satisfies CloudAgentSessionState;

describe('validateTerminalMetadata', () => {
  it('allows prepared interactive cloud-agent sessions', () => {
    const result = validateTerminalMetadata(baseMetadata, baseMetadata.identity.sessionId);

    expect(result).toEqual({ success: true, data: { metadata: baseMetadata } });
  });

  it('allows prepared Slack-created cloud-agent sessions', () => {
    const metadata = {
      ...baseMetadata,
      identity: { ...baseMetadata.identity, createdOnPlatform: 'slack' },
    };
    const result = validateTerminalMetadata(metadata, baseMetadata.identity.sessionId);

    expect(result).toEqual({ success: true, data: { metadata } });
  });

  it('rejects sessions created by unsupported platforms', () => {
    const result = validateTerminalMetadata(
      {
        ...baseMetadata,
        identity: { ...baseMetadata.identity, createdOnPlatform: 'code-review' },
      },
      baseMetadata.identity.sessionId
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is only available for interactive Cloud Agent sessions',
    });
  });

  it('rejects unprepared sessions', () => {
    const result = validateTerminalMetadata(
      {
        ...baseMetadata,
        lifecycle: { ...baseMetadata.lifecycle, preparedAt: undefined },
      },
      baseMetadata.identity.sessionId
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is only available after the workspace is prepared',
    });
  });

  it('treats minimal async-preparation metadata as unprepared', () => {
    const result = validateTerminalMetadata(
      {
        metadataSchemaVersion: 2,
        identity: {
          sessionId: baseMetadata.identity.sessionId,
          userId: baseMetadata.identity.userId,
        },
        auth: {},
        lifecycle: {
          version: baseMetadata.lifecycle.version,
          timestamp: baseMetadata.lifecycle.timestamp,
        },
      },
      baseMetadata.identity.sessionId
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is only available after the workspace is prepared',
    });
  });
});

function sandboxWithTerminalResult(
  getRunningTerminalClient: AgentSandbox['getRunningTerminalClient']
): AgentSandbox {
  return {
    ensureWrapper: vi.fn(),
    discoverSessionWrappers: vi.fn(),
    stopWrappers: vi.fn(),
    probeHealth: vi.fn(),
    getRunningWrapper: vi.fn(),
    getRunningTerminalClient,
    readWrapperLogs: vi.fn(),
    keepAlive: vi.fn(),
    delete: vi.fn(),
  };
}

describe('resolveTerminalWrapperClient', () => {
  it('returns the ready terminal client from the selected AgentSandbox', async () => {
    const client = {
      health: vi.fn(),
      createTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      connectTerminal: vi.fn(),
    };
    const getRunningTerminalClient = vi.fn().mockResolvedValue({ status: 'ready', client });

    const result = await resolveTerminalWrapperClient(
      {
        env: {} as Env,
        metadata: baseMetadata,
        sessionId: baseMetadata.identity.sessionId,
      },
      {
        createSandbox: vi.fn().mockReturnValue(sandboxWithTerminalResult(getRunningTerminalClient)),
      }
    );

    expect(result).toEqual({ success: true, data: { client } });
    expect(getRunningTerminalClient).toHaveBeenCalledOnce();
  });

  it('preserves not-running as a distinct terminal-unavailable outcome', async () => {
    const result = await resolveTerminalWrapperClient(
      {
        env: {} as Env,
        metadata: baseMetadata,
        sessionId: baseMetadata.identity.sessionId,
      },
      {
        createSandbox: vi
          .fn()
          .mockReturnValue(
            sandboxWithTerminalResult(vi.fn().mockResolvedValue({ status: 'not-running' }))
          ),
      }
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is unavailable because the session wrapper is not running',
    });
  });

  it('preserves the unhealthy-wrapper terminal diagnostic', async () => {
    const result = await resolveTerminalWrapperClient(
      {
        env: {} as Env,
        metadata: baseMetadata,
        sessionId: baseMetadata.identity.sessionId,
      },
      {
        createSandbox: vi
          .fn()
          .mockReturnValue(
            sandboxWithTerminalResult(vi.fn().mockResolvedValue({ status: 'unhealthy' }))
          ),
      }
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is unavailable because the session wrapper is not healthy',
    });
  });

  it('surfaces the provider capability-unavailable outcome reported by the sandbox', async () => {
    const getRunningTerminalClient = vi.fn().mockResolvedValue({
      status: 'capability-unavailable',
      message: 'Terminal access is unavailable for this sandbox provider',
    });
    const createSandbox = vi
      .fn()
      .mockReturnValue(sandboxWithTerminalResult(getRunningTerminalClient));
    const result = await resolveTerminalWrapperClient(
      {
        env: {} as Env,
        metadata: baseMetadata,
        sessionId: baseMetadata.identity.sessionId,
      },
      { createSandbox }
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal access is unavailable for this sandbox provider',
    });
  });

  it('maps sandbox construction failures to a terminal-unavailable outcome', async () => {
    const createSandbox = vi.fn(() => {
      throw new AgentSandboxUnavailableError(
        'Sandbox operational configuration is incomplete',
        'provider_not_configured'
      );
    });
    const result = await resolveTerminalWrapperClient(
      {
        env: {} as Env,
        metadata: baseMetadata,
        sessionId: baseMetadata.identity.sessionId,
      },
      { createSandbox }
    );

    expect(result).toEqual({
      success: false,
      error: 'Sandbox operational configuration is incomplete',
    });
  });
});
