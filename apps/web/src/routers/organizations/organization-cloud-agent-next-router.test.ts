import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type * as TrpcInitModule from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';

const ORGANIZATION_ID = '9a283301-b75d-4375-a1ba-e319a02e18b7';

const mockPrepareSession = jest.fn<
  (input: {
    githubRepo?: string;
    devcontainer?: boolean;
    kilocodeOrganizationId?: string;
  }) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>
>();

const mockCreateCloudAgentNextClient = jest.fn(() => ({
  prepareSession: mockPrepareSession,
}));

const mockIsFeatureFlagEnabledOrDevelopment =
  jest.fn<(flagName: string, distinctId: string) => Promise<boolean>>();

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: jest.fn(() => 'cloud-agent-token'),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  rethrowAsPaymentRequired: jest.fn(),
}));

jest.mock('@/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabledOrDevelopment: mockIsFeatureFlagEnabledOrDevelopment,
}));

jest.mock('@/routers/organizations/utils', () => {
  const trpcInit = jest.requireActual<typeof TrpcInitModule>('@/lib/trpc/init');

  return {
    organizationMemberProcedure: trpcInit.baseProcedure,
    organizationMemberMutationProcedure: trpcInit.baseProcedure,
  };
});

let createCaller: (ctx: { user: User }) => {
  prepareSession: (input: {
    organizationId: string;
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
  const mod = await import('./organization-cloud-agent-next-router');
  createCaller = createCallerFactory(mod.organizationCloudAgentNextRouter);
});

describe('organizationCloudAgentNextRouter.prepareSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
  });

  it('rejects devcontainer sessions when the feature flag is disabled', async () => {
    mockIsFeatureFlagEnabledOrDevelopment.mockResolvedValue(false);
    const caller = createCaller({
      user: { id: 'user-1', is_admin: true } as User,
    });

    await expect(
      caller.prepareSession({
        organizationId: ORGANIZATION_ID,
        prompt: 'Test prompt',
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        devcontainer: true,
      })
    ).rejects.toThrow('Dev container sessions are not available');
    expect(mockIsFeatureFlagEnabledOrDevelopment).toHaveBeenCalledWith(
      'cloud-agent-devcontainer',
      ORGANIZATION_ID
    );
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('forwards devcontainer sessions when the feature flag is enabled', async () => {
    mockIsFeatureFlagEnabledOrDevelopment.mockResolvedValue(true);
    const caller = createCaller({
      user: { id: 'user-2', is_admin: false } as User,
    });

    await expect(
      caller.prepareSession({
        organizationId: ORGANIZATION_ID,
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
    expect(mockIsFeatureFlagEnabledOrDevelopment).toHaveBeenCalledWith(
      'cloud-agent-devcontainer',
      ORGANIZATION_ID
    );
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: 'acme/repo',
        devcontainer: true,
        kilocodeOrganizationId: ORGANIZATION_ID,
      })
    );
  });
});
