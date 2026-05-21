import { describe, expect, it, vi } from 'vitest';
import type { CloudAgentSessionState } from '../persistence/types.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';
import type { Env, SandboxInstance } from '../types.js';
import { resolveTerminalWrapperClient, validateTerminalMetadata } from './access.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

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

  it('rejects sessions created by non-interactive platforms', () => {
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

describe('resolveTerminalWrapperClient', () => {
  it('returns a healthy existing wrapper client', async () => {
    const sandbox = {} as SandboxInstance;
    const client = {
      health: vi.fn().mockResolvedValue({
        healthy: true,
        state: 'idle',
        version: WRAPPER_VERSION,
        sessionId: 'kilo-session-1',
      }),
      createTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      connectTerminal: vi.fn(),
    };

    const result = await resolveTerminalWrapperClient(
      {
        env: { PER_SESSION_SANDBOX_ORG_IDS: '' } as Env,
        metadata: baseMetadata,
        sessionId: baseMetadata.identity.sessionId,
      },
      {
        getSandboxInstance: vi.fn().mockReturnValue(sandbox),
        findWrapperForSession: vi.fn().mockResolvedValue({ port: 5050 }),
        createClient: vi.fn().mockReturnValue(client),
      }
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      client,
      sandbox,
      port: 5050,
    });
    expect(client.health).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable when no existing wrapper process is running', async () => {
    const findWrapperForSession = vi.fn().mockResolvedValue(null);
    const health = vi.fn();

    const result = await resolveTerminalWrapperClient(
      {
        env: { PER_SESSION_SANDBOX_ORG_IDS: '' } as Env,
        metadata: baseMetadata,
        sessionId: baseMetadata.identity.sessionId,
      },
      {
        getSandboxInstance: vi.fn().mockReturnValue({} as SandboxInstance),
        findWrapperForSession,
        createClient: vi.fn().mockReturnValue({ health }),
      }
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is unavailable because the session wrapper is not running',
    });
    expect(findWrapperForSession).toHaveBeenCalledTimes(1);
    expect(health).not.toHaveBeenCalled();
  });
});
