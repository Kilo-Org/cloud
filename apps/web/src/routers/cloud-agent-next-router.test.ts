import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';

const mockPrepareSession = jest.fn<
  (input: { githubRepo?: string; devcontainer?: boolean }) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>
>();

const mockCreateCloudAgentNextClient = jest.fn(() => ({
  prepareSession: mockPrepareSession,
}));

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: jest.fn(() => 'cloud-agent-token'),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  rethrowAsPaymentRequired: jest.fn(),
}));

let createCaller: (ctx: { user: User }) => {
  prepareSession: (input: {
    prompt: string;
    mode: string;
    model: string;
    githubRepo: string;
    autoInitiate: boolean;
    devcontainer: boolean;
  }) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>;
};

beforeAll(async () => {
  const mod = await import('./cloud-agent-next-router');
  createCaller = createCallerFactory(mod.cloudAgentNextRouter);
});

describe('cloudAgentNextRouter.prepareSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
  });

  it('rejects devcontainer sessions for non-admin users', async () => {
    const caller = createCaller({
      user: { id: 'user-1', is_admin: false } as User,
    });

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        devcontainer: true,
      })
    ).rejects.toThrow('Admin access required for devcontainer sessions');
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('forwards devcontainer sessions for admin users', async () => {
    const caller = createCaller({
      user: { id: 'admin-1', is_admin: true } as User,
    });

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        devcontainer: true,
      })
    ).resolves.toEqual({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: 'acme/repo',
        devcontainer: true,
      })
    );
  });
});
