import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import type { startAskUsageSession as StartAskUsageSessionFn } from './start-ask-usage-session';
import type { usageAnalystPermission as UsageAnalystPermission } from './usage-analyst-config';

const mockMintAccessToken =
  jest.fn<
    (input: { userId: string; clientId: string; scopes: string[] }) => Promise<{ token: string }>
  >();
const mockPrepareSession =
  jest.fn<
    (
      input: Record<string, unknown>
    ) => Promise<{ cloudAgentSessionId: string; kiloSessionId: string }>
  >();
const mockCreateCloudAgentNextClient = jest.fn<
  (token: string) => { prepareSession: typeof mockPrepareSession }
>(() => ({
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

let startAskUsageSession: typeof StartAskUsageSessionFn;
let usageAnalystPermission: typeof UsageAnalystPermission;
const originalCloudAgentMcpAppBaseUrl = process.env.MCP_GATEWAY_CLOUD_AGENT_APP_BASE_URL;

beforeAll(async () => {
  ({ startAskUsageSession } = await import('./start-ask-usage-session'));
  ({ usageAnalystPermission } = await import('./usage-analyst-config'));
});

afterAll(() => {
  if (originalCloudAgentMcpAppBaseUrl === undefined) {
    delete process.env.MCP_GATEWAY_CLOUD_AGENT_APP_BASE_URL;
  } else {
    process.env.MCP_GATEWAY_CLOUD_AGENT_APP_BASE_URL = originalCloudAgentMcpAppBaseUrl;
  }
});

describe('startAskUsageSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    if (originalCloudAgentMcpAppBaseUrl === undefined) {
      delete process.env.MCP_GATEWAY_CLOUD_AGENT_APP_BASE_URL;
    } else {
      process.env.MCP_GATEWAY_CLOUD_AGENT_APP_BASE_URL = originalCloudAgentMcpAppBaseUrl;
    }
    mockMintAccessToken.mockResolvedValue({ token: 'native-mcp-token' });
    mockFindEligibleNativeMcpUser.mockResolvedValue({ id: 'user-1', is_admin: true } as User);
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
  });

  it('creates a blank MCP-connected Usage Analyst session without leaking secrets', async () => {
    await expect(
      startAskUsageSession({
        user: { id: 'user-1', is_admin: true } as User,
        input: { model: 'anthropic/claude-sonnet-4.5', variant: 'low' },
      })
    ).resolves.toEqual({ kiloSessionId: 'ses_12345678901234567890123456' });

    expect(mockMintAccessToken).toHaveBeenCalledWith({
      userId: 'user-1',
      clientId: 'internal:kilo-usage-ai',
      scopes: ['mcp:access'],
    });
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('cloud-agent-token');
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
    const prepared = mockPrepareSession.mock.calls[0]?.[0];
    expect(prepared).not.toHaveProperty('gitUrl');
    expect(JSON.stringify(prepared)).not.toContain('native-mcp-token');
    expect(JSON.stringify(prepared)).toContain('kilo_usage/query_kilo_dataset');
    expect(JSON.stringify(prepared)).toContain('There is no kilo_usage_render_result tool');
    expect(JSON.stringify(prepared)).toContain('Never write XML-style tool markup');
    expect(JSON.stringify(prepared)).toContain('Session datasets support count only');
    expect(JSON.stringify(prepared)).toContain('microdollar_usage metrics:');
    expect(JSON.stringify(prepared)).toContain('code_reviews metrics:');
    expect(prepared).toEqual(
      expect.objectContaining({
        runtimeAgents: [
          expect.objectContaining({
            slug: 'usage-analyst',
            name: 'Usage Analyst',
            config: expect.objectContaining({
              permission: usageAnalystPermission,
            }),
          }),
        ],
      })
    );
  });

  it('uses the default model when none is selected', async () => {
    await startAskUsageSession({
      user: { id: 'user-1', is_admin: true } as User,
      input: undefined,
    });

    expect(mockPrepareSession.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: 'kilo-auto/balanced', variant: undefined })
    );
  });

  it('can use a sandbox-facing MCP URL without changing gateway public app URL', async () => {
    process.env.MCP_GATEWAY_CLOUD_AGENT_APP_BASE_URL = 'http://host.docker.internal:3000';

    await startAskUsageSession({
      user: { id: 'user-1', is_admin: true } as User,
      input: undefined,
    });

    expect(mockPrepareSession.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        mcpServers: {
          kilo_usage: expect.objectContaining({
            url: 'http://host.docker.internal:3000/mcp',
          }),
        },
      })
    );
    expect(mockMintAccessToken).toHaveBeenCalledWith({
      userId: 'user-1',
      clientId: 'internal:kilo-usage-ai',
      scopes: ['mcp:access'],
    });
  });

  it('rejects ineligible admins', async () => {
    mockFindEligibleNativeMcpUser.mockResolvedValue(null);

    await expect(
      startAskUsageSession({ user: { id: 'user-1', is_admin: true } as User, input: undefined })
    ).rejects.toEqual(
      new TRPCError({
        code: 'FORBIDDEN',
        message: 'Ask Usage is only available to eligible Kilo organization admins',
      })
    );
    expect(mockPrepareSession).not.toHaveBeenCalled();
  });

  it('keeps the exact deny-all permission map with only the dataset query tool allowed', () => {
    expect(usageAnalystPermission).toEqual({
      '*': 'deny',
      read: 'deny',
      edit: 'deny',
      glob: 'deny',
      grep: 'deny',
      list: 'deny',
      bash: 'deny',
      task: 'deny',
      external_directory: { '*': 'deny' },
      todowrite: 'deny',
      todoread: 'deny',
      question: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      codesearch: 'deny',
      lsp: 'deny',
      skill: 'deny',
      suggest: 'deny',
      kilo_usage_query_kilo_dataset: 'allow',
    });
  });
});
