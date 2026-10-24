import type { PlatformIntegration, User } from '@kilocode/db';
import type { Thread } from 'chat';
import jwt from 'jsonwebtoken';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { createRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import { prepareCloudAgentWorkflowUser } from '@/lib/auth/cloud-agent-workflow-user';
import {
  createCloudAgentNextClient,
  createCloudAgentNextClientForModel,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import type { PrepareSessionInput } from '@/lib/cloud-agent-next/cloud-agent-client';
import { computeCloudAgentNextBalanceCheckEligibility } from '@/lib/cloud-agent-next/balance-check-eligibility';
import type SpawnCloudAgentSession from './tools/spawn-cloud-agent-session';
import { runBotAgent } from './agent-runner';

type TestAgentOptions = {
  tools: {
    spawnCloudAgentSession: {
      execute: (
        input: Parameters<typeof SpawnCloudAgentSession>[0]
      ) => ReturnType<typeof SpawnCloudAgentSession>;
    };
  };
};

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  isResourceTokenIssuanceEnabled: () => true,
}));
jest.mock('@/lib/auth/cloud-agent-workflow-user', () => ({
  prepareCloudAgentWorkflowUser: jest.fn(),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: jest.fn() }));
jest.mock(
  'chat',
  () => ({
    Actions: jest.fn(),
    Card: jest.fn(),
    CardText: jest.fn(),
    LinkButton: jest.fn(),
    Section: jest.fn(),
  }),
  { virtual: true }
);
jest.mock('ai', () => ({
  ToolLoopAgent: jest.fn(({ tools }: TestAgentOptions) => ({
    generate: async () => ({
      text: (
        await tools.spawnCloudAgentSession.execute({
          githubRepo: 'owner/repository',
          prompt: 'Audit dependencies',
          mode: 'ask',
        })
      ).response,
    }),
  })),
  tool: (definition: unknown) => definition,
  isStepCount: jest.fn(),
  generateText: jest.fn(async () => ({ text: 'Audit dependencies' })),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    requireByAdapter: () => ({
      getConversationContext: async () => '',
      documentationUrl: 'https://example.test/docs',
    }),
  },
}));
jest.mock('@/lib/bot/request-logging', () => ({
  updateBotRequest: jest.fn(),
  linkBotRequestToSession: jest.fn(),
  recordBotRequestCloudAgentSession: jest.fn(),
}));
jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  getGitHubRepositoryContext: async () => ({}),
  formatGitHubRepositoriesForPrompt: () => '',
  resolveGitHubRepositoryForOwner: async () => ({ githubIntegrationId: 'github-integration' }),
}));
jest.mock('@/lib/slack-bot/gitlab-repository-context', () => ({
  getGitLabRepositoryContext: async () => ({}),
  formatGitLabRepositoriesForPrompt: () => '',
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: async () => ({ id: 'github-integration' }),
}));
jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({}));
jest.mock('@/lib/bot-users/bot-user-service', () => ({}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(),
  createCloudAgentNextClientForModel: jest.fn(),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));
jest.mock('@/lib/cloud-agent-next/balance-check-eligibility', () => ({
  computeCloudAgentNextBalanceCheckEligibility: jest.fn(),
}));
jest.mock('@/lib/web-config.server', () => ({ CALLBACK_TOKEN_SECRET: 'test-callback-secret' }));
jest.mock('@kilocode/web-shared/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: async () => false,
}));

const user = { id: 'oauth/bot-owner', api_token_pepper: 'current-pepper' } as User;
const organizationIntegration = {
  owned_by_organization_id: 'organization-1',
  owned_by_user_id: null,
} as PlatformIntegration;
const personalIntegration = {
  owned_by_organization_id: null,
  owned_by_user_id: user.id,
} as PlatformIntegration;

const mockInitiate = jest.fn();
const mockPrepare = jest.fn();
const mockOnSessionReady = jest.fn();
let membershipAvailable = true;

function run(platformIntegration: PlatformIntegration, inputUser = user) {
  return runBotAgent({
    thread: {
      adapter: { name: 'slack' },
      startTyping: jest.fn(),
      postEphemeral: jest.fn(async () => undefined),
    } as unknown as Thread,
    message: {
      id: 'message-1',
      text: 'Audit dependencies',
      author: { userId: user.id, userName: 'Owner', fullName: 'Owner', isBot: false, isMe: false },
    },
    platformIntegration,
    user: inputUser,
    botRequestId: 'request-1',
    prompt: 'Audit dependencies',
    onSessionReady: mockOnSessionReady,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  membershipAvailable = true;
  jest.mocked(prepareCloudAgentWorkflowUser).mockResolvedValue(user);
  jest.mocked(computeCloudAgentNextBalanceCheckEligibility).mockResolvedValue({
    isFree: false,
    hasUserByokAvailable: false,
  });
  jest.mocked(createOpenAICompatible).mockReturnValue({ chatModel: jest.fn() } as never);
  jest
    .mocked(createCloudAgentNextClientForModel)
    .mockImplementation(token => jest.mocked(createCloudAgentNextClient)(token) as never);
  jest.mocked(createCloudAgentNextClient).mockImplementation(token => {
    mockPrepare.mockImplementation(async (input: PrepareSessionInput) => {
      const runtime = await createRuntimeAuthorization({
        token,
        secret: NEXTAUTH_SECRET,
        connectionString: 'postgres://unused',
        resourceKind: 'cloud-agent-next',
        resourceId: 'workspace_test',
        organizationId: input.kilocodeOrganizationId,
        adapters: {
          getPrincipal: async ({ userId }) =>
            userId === user.id
              ? {
                  id: user.id,
                  apiTokenPepper: user.api_token_pepper,
                  blockedAt: null,
                  blockedReason: null,
                  isBot: false,
                }
              : null,
          getMembership: async ({ userId, organizationId }) =>
            membershipAvailable && userId === user.id && organizationId === 'organization-1'
              ? { id: 'membership-1', role: 'member', organizationDeletedAt: null }
              : null,
        },
      });
      expect(jwt.verify(runtime.token, NEXTAUTH_SECRET)).toMatchObject({
        runtimeAuthorization: { resourceKind: 'cloud-agent-next', resourceId: 'workspace_test' },
      });
      return { cloudAgentSessionId: 'workspace_test', kiloSessionId: 'ses_test' };
    });
    return {
      prepareSession: mockPrepare,
      initiateFromPreparedSession: mockInitiate,
    } as never;
  });
});

it.each([
  ['organization', organizationIntegration],
  ['personal', personalIntegration],
] as const)(
  'prepares and initiates a %s session with modern runtime admission',
  async (_, integration) => {
    const result = await run(integration);
    expect(result.startedCloudAgentSession).toBe(true);
    const controlToken = jest.mocked(createCloudAgentNextClient).mock.calls[0][0];
    const claims = jwt.verify(controlToken, NEXTAUTH_SECRET);
    expect(claims).toMatchObject({
      kiloUserId: user.id,
      aud: 'cloud-agent-next',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
      tokenSource: 'kilo-bot',
      createdOnPlatform: 'slack',
      runtimeAdmission: {
        source: 'automation',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    });
    expect(claims).not.toHaveProperty('internalApiUse');
    if (typeof claims === 'string' || claims.exp === undefined || claims.iat === undefined) {
      throw new Error('Missing control token lifetime');
    }
    expect(claims.exp - claims.iat).toBe(3600);
    if (integration.owned_by_organization_id) {
      expect(claims.organizationId).toBe('organization-1');
    } else {
      expect(claims).not.toHaveProperty('organizationId');
    }
    expect(mockInitiate).toHaveBeenCalledWith({ cloudAgentSessionId: 'workspace_test' });
    expect(mockOnSessionReady).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_test',
      kiloSessionId: 'ses_test',
      prompt: 'Audit dependencies',
    });

    const providerOptions = jest.mocked(createOpenAICompatible).mock.calls[0][0];
    expect(providerOptions.apiKey).toBeDefined();
    expect(jwt.verify(providerOptions.apiKey ?? '', NEXTAUTH_SECRET)).toMatchObject({
      kiloUserId: user.id,
      internalApiUse: true,
    });
    expect(providerOptions.headers?.['X-KiloCode-OrganizationId']).toBe(
      integration.owned_by_organization_id ?? undefined
    );
    expect(providerOptions.apiKey).not.toBe(controlToken);
  }
);

it('uses the current workflow user when the caller has a stale null pepper', async () => {
  const staleUser = { ...user, api_token_pepper: null };
  const result = await run(organizationIntegration, staleUser);
  expect(prepareCloudAgentWorkflowUser).toHaveBeenCalledWith(staleUser);
  expect(result.startedCloudAgentSession).toBe(true);
});

it('rejects organization runtime admission when membership is missing', async () => {
  membershipAvailable = false;
  const result = await run(organizationIntegration);
  expect(result.startedCloudAgentSession).toBe(false);
  expect(result.finalText).toContain('Invalid runtime admission');
  expect(mockInitiate).not.toHaveBeenCalled();
  expect(mockOnSessionReady).not.toHaveBeenCalled();
});
