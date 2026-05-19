import { describe, expect, it, vi } from 'vitest';
import type { CloudAgentSessionState } from '../persistence/types.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';
import type { Env, SandboxInstance } from '../types.js';
import { resolveTerminalWrapperClient, validateTerminalMetadata } from './access.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

const baseMetadata: CloudAgentSessionState = {
  version: 1,
  sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
  userId: 'user-1',
  timestamp: 1,
  preparedAt: 1,
  workspacePath: '/workspace/repo',
  createdOnPlatform: 'cloud-agent-web',
};

describe('validateTerminalMetadata', () => {
  it('allows prepared interactive cloud-agent sessions', () => {
    const result = validateTerminalMetadata(baseMetadata, baseMetadata.sessionId);

    expect(result).toEqual({ success: true, data: { metadata: baseMetadata } });
  });

  it('rejects sessions created by non-interactive platforms', () => {
    const result = validateTerminalMetadata(
      { ...baseMetadata, createdOnPlatform: 'code-review' },
      baseMetadata.sessionId
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is only available for interactive Cloud Agent sessions',
    });
  });

  it('rejects unprepared sessions', () => {
    const result = validateTerminalMetadata(
      { ...baseMetadata, preparedAt: undefined },
      baseMetadata.sessionId
    );

    expect(result).toEqual({
      success: false,
      error: 'Terminal is only available after the workspace is prepared',
    });
  });

  it('treats minimal async-preparation metadata as unprepared', () => {
    const result = validateTerminalMetadata(
      {
        ...baseMetadata,
        preparedAt: undefined,
        workspacePath: undefined,
        createdOnPlatform: undefined,
      },
      baseMetadata.sessionId
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
        sessionId: baseMetadata.sessionId,
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
        sessionId: baseMetadata.sessionId,
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
