import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { createCallerFactory } from '@/lib/trpc/init';

const mockMintAccessToken = jest.fn<() => Promise<{ token: string }>>();
const mockPrepareSession =
  jest.fn<
    (input: {
      prompt: string;
      repositorySource?: 'empty-local';
      gitUrl?: string;
      model?: string;
      variant?: string;
      autoInitiate?: boolean;
      mcpServers?: Record<string, unknown>;
    }) => Promise<{ cloudAgentSessionId: string; kiloSessionId: string }>
  >();
const mockCreateCloudAgentNextClient = jest.fn(() => ({
  prepareSession: mockPrepareSession,
}));
const mockFindEligibleNativeMcpUser = jest.fn<(userId: string) => Promise<User | null>>();
const mockEncryptWithPublicKey = jest.fn(() => ({
  encryptedData: 'encrypted-data',
  encryptedDEK: 'encrypted-dek',
  algorithm: 'rsa-aes-256-gcm' as const,
  version: 1 as const,
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  rethrowAsPaymentRequired: jest.fn((error: unknown) => {
    throw error;
  }),
}));

jest.mock('@/lib/config.server', () => ({
  AGENT_ENV_VARS_PUBLIC_KEY: Buffer.from('test-public-key').toString('base64'),
}));

jest.mock('@/lib/encryption', () => ({
  encryptWithPublicKey: mockEncryptWithPublicKey,
}));

jest.mock('@/lib/mcp-gateway/services', () => ({
  createGatewayServices: jest.fn(() => ({
    config: { appBaseUrl: 'https://app.example.test' },
    nativeMcpTokenService: {
      mintAccessToken: mockMintAccessToken,
    },
  })),
}));

jest.mock('@/lib/native-mcp/oauth/native-token-verifier', () => ({
  findEligibleNativeMcpUser: mockFindEligibleNativeMcpUser,
}));

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: jest.fn(() => 'cloud-agent-token'),
}));

let createCaller: (ctx: { user: User }) => {
  start: (input?: { model?: string; variant?: string }) => Promise<{ kiloSessionId: string }>;
};

beforeAll(async () => {
  const mod = await import('./kilo-usage-ai-router');
  createCaller = createCallerFactory(mod.adminKiloUsageAiRouter);
});

describe('adminKiloUsageAiRouter.start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMintAccessToken.mockResolvedValue({ token: 'native-mcp-token' });
    mockFindEligibleNativeMcpUser.mockResolvedValue({
      id: 'user-1',
      is_admin: true,
    } as User);
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
  });

  it('creates a blank MCP-connected Usage Analyst session without auto-submitting analysis', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: true } as User });

    await expect(
      caller.start({ model: 'anthropic/claude-sonnet-4.5', variant: 'low' })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repositorySource: 'empty-local',
        mode: 'usage-analyst',
        model: 'anthropic/claude-sonnet-4.5',
        variant: 'low',
        prompt: 'Blank Ask Usage session. Wait for the user to ask a question.',
        autoCommit: false,
        autoInitiate: false,
        createdOnPlatform: 'kilo-usage-ai',
        mcpServers: {
          kilo_usage: {
            type: 'remote',
            url: 'https://app.example.test/mcp',
            headers: {
              Authorization: {
                encryptedData: 'encrypted-data',
                encryptedDEK: 'encrypted-dek',
                algorithm: 'rsa-aes-256-gcm',
                version: 1,
              },
            },
          },
        },
      })
    );
    expect(mockPrepareSession.mock.calls[0]?.[0]).not.toHaveProperty('gitUrl');
    expect(mockPrepareSession.mock.calls[0]?.[0].prompt).not.toContain('30-day overview');
    expect(mockPrepareSession.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        runtimeAgents: [
          expect.objectContaining({
            config: expect.not.objectContaining({ model: expect.any(String) }),
          }),
        ],
      })
    );
  });
});
