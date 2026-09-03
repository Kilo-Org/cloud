import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as TrpcClientModule from '@trpc/client';
import type * as CloudAgentClientModule from './cloud-agent-client';
import {
  getSandboxAllocationRequest,
  type SandboxAllocationInput,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type {
  ComputeBillingStatus,
  CreateWorktreeChatInput,
  CreateWorktreeChatOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  GetSessionInput,
  PrepareSessionInput,
  SendMessageInput,
} from './cloud-agent-client';
import { signKiloToken } from '@kilocode/worker-utils/kilo-token';

const mockCreateTRPCClient = jest.fn(() => ({}));
const mockHttpLink =
  jest.fn<(options: { url: string; headers: () => Record<string, string> }) => undefined>();
const mockCaptureException = jest.fn();

import type * as SentryModule from '@sentry/nextjs';
import type { SandboxStatusSnapshot } from '@/routers/cloud-agent-next-schemas';

jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: jest.fn(() => 'http://cloud-agent-next'),
}));

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
}));

jest.mock('@trpc/client', () => ({
  ...jest.requireActual<typeof TrpcClientModule>('@trpc/client'),
  createTRPCClient: mockCreateTRPCClient,
  httpLink: mockHttpLink,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: mockCaptureException,
}));

jest.mock('./cloud-agent-client', () => {
  const createCloudAgentNextClient = jest.fn((_token: string) => ({ marker: 'default' }));
  const createAppBuilderCloudAgentNextClient = jest.fn((_token: string) => ({
    marker: 'appbuilder',
  }));
  return {
    createCloudAgentNextClient,
    createAppBuilderCloudAgentNextClient,
    createCloudAgentNextClientForModel: jest.fn(
      (token: string, model: { isFree: boolean; hasUserByokAvailable: boolean }) =>
        model.isFree || model.hasUserByokAvailable
          ? createAppBuilderCloudAgentNextClient(token)
          : createCloudAgentNextClient(token)
    ),
    rethrowAsPaymentRequired: jest.fn(),
  };
});

const { createTRPCClient, TRPCClientError } =
  jest.requireMock<jest.Mocked<typeof TrpcClientModule>>('@trpc/client');
const { captureException } = jest.requireMock<jest.Mocked<typeof SentryModule>>('@sentry/nextjs');

const clientModule: {
  createCloudAgentNextClient: jest.Mock;
  createAppBuilderCloudAgentNextClient: jest.Mock;
  createCloudAgentNextClientForModel: (
    token: string,
    model: { isFree: boolean; hasUserByokAvailable: boolean }
  ) => unknown;
} = jest.requireMock('./cloud-agent-client');

const {
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createAppBuilderCloudAgentNextClient: mockCreateAppBuilderCloudAgentNextClient,
  createCloudAgentNextClientForModel,
} = clientModule;

beforeEach(() => {
  mockCreateCloudAgentNextClient.mockClear();
  mockCreateAppBuilderCloudAgentNextClient.mockClear();
  mockCreateTRPCClient.mockClear();
  mockHttpLink.mockClear();
  mockCaptureException.mockClear();
});

// Load the real `closeCloudAgentOrgStreams` (the module mock above does not
// expose it) so the test exercises the actual fetch call, not a stub.
const realCloudAgentClientModule =
  jest.requireActual<typeof CloudAgentClientModule>('./cloud-agent-client');
const { closeCloudAgentOrgStreams, CloudAgentNextClient, createAppBuilderCloudAgentNextClient } =
  realCloudAgentClientModule;

describe('createCloudAgentNextClientForModel', () => {
  it('returns the default client when the model is paid and has no BYOK', () => {
    const result = createCloudAgentNextClientForModel('token', {
      isFree: false,
      hasUserByokAvailable: false,
    });
    expect(result).toEqual({ marker: 'default' });
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('token');
    expect(mockCreateAppBuilderCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('returns the AppBuilder client when the model is free', () => {
    const result = createCloudAgentNextClientForModel('token', {
      isFree: true,
      hasUserByokAvailable: false,
    });
    expect(result).toEqual({ marker: 'appbuilder' });
    expect(mockCreateAppBuilderCloudAgentNextClient).toHaveBeenCalledWith('token');
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('returns the AppBuilder client when the model is BYOK-capable, even if it is not free', () => {
    const result = createCloudAgentNextClientForModel('token', {
      isFree: false,
      hasUserByokAvailable: true,
    });
    expect(result).toEqual({ marker: 'appbuilder' });
    expect(mockCreateAppBuilderCloudAgentNextClient).toHaveBeenCalledWith('token');
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });
});

describe('createAppBuilderCloudAgentNextClient', () => {
  it('forwards the original App Builder JWT to Cloud Agent Next with its dedicated policy headers', async () => {
    const { token } = await signKiloToken({
      userId: 'synthetic-app-builder-user',
      pepper: 'synthetic-app-builder-pepper',
      secret: 'synthetic-app-builder-secret',
      expiresInSeconds: 60,
      extra: { tokenSource: 'app-builder' },
    });
    const prepareSession = jest.fn(async () => ({
      kiloSessionId: 'ses_12345678901234567890123456',
      cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
    }));
    const getSession = jest.fn<
      (input: { cloudAgentSessionId: string }) => Promise<Record<string, never>>
    >(async () => ({}));
    const interruptSession = jest.fn<
      (input: {
        sessionId: string;
      }) => Promise<{ success: boolean; message: string; processesFound: boolean }>
    >(async () => ({
      success: true,
      message: 'interrupted',
      processesFound: true,
    }));
    const initiateFromKilocodeSessionV2 = jest.fn<
      (input: { cloudAgentSessionId: string }) => Promise<Record<string, never>>
    >(async () => ({}));
    const sendMessageV2 = jest.fn(async () => ({}));
    mockCreateTRPCClient.mockReturnValueOnce({
      prepareSession: { mutate: prepareSession },
      getSession: { query: getSession },
      interruptSession: { mutate: interruptSession },
      initiateFromKilocodeSessionV2: { mutate: initiateFromKilocodeSessionV2 },
      sendMessageV2: { mutate: sendMessageV2 },
    });

    const client = createAppBuilderCloudAgentNextClient(token);
    const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
    await client.prepareSession({ prompt: 'Build an app', mode: 'code', model: 'kilo/test-model' });
    await client.getSession(cloudAgentSessionId);
    await client.interruptSession(cloudAgentSessionId);
    await client.initiateFromPreparedSession({ cloudAgentSessionId });
    await client.sendMessage({
      cloudAgentSessionId,
      payload: { type: 'prompt', prompt: 'Continue', mode: 'code', model: 'kilo/test-model' },
    });

    expect(mockHttpLink).toHaveBeenCalledWith({
      url: 'http://cloud-agent-next/trpc',
      headers: expect.any(Function),
    });
    expect(mockHttpLink.mock.calls[0]?.[0].headers()).toEqual({
      Authorization: `Bearer ${token}`,
      'x-skip-balance-check': 'true',
      'x-internal-api-key': 'test-secret',
    });
    expect(prepareSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith({ cloudAgentSessionId });
    expect(interruptSession).toHaveBeenCalledWith({ sessionId: cloudAgentSessionId });
    expect(initiateFromKilocodeSessionV2).toHaveBeenCalledWith({ cloudAgentSessionId });
    expect(sendMessageV2).toHaveBeenCalledTimes(1);
  });
});

describe('CloudAgentNextClient sandbox selection', () => {
  const kilocodeOrganizationId = '9a283301-b75d-4375-a1ba-e319a02e18b7';

  it.each([undefined, false, true])(
    'forwards optional devcontainer context: %j',
    async devcontainer => {
      const input = {
        kilocodeOrganizationId,
        ...(devcontainer !== undefined ? { devcontainer } : {}),
      };
      const capabilities: SandboxSelectionCapabilities = {
        enabled: true,
        defaultDestination: {
          provider: { id: 'vercel', account: 'kilo' },
          instanceType: 'default',
        },
        options: [
          { allocation: getSandboxAllocationRequest('vercel-large'), available: true },
          {
            allocation: { provider: { id: 'vercel', account: 'byoc' }, instanceType: 'small' },
            available: false,
            reason: 'Account unavailable',
          },
        ],
      };
      const query = jest
        .fn<CloudAgentClientModule.CloudAgentNextClient['getSandboxSelectionOptions']>()
        .mockResolvedValue(capabilities);
      mockCreateTRPCClient.mockReturnValueOnce({ getSandboxSelectionOptions: { query } });

      await expect(
        new CloudAgentNextClient('auth-token').getSandboxSelectionOptions(input)
      ).resolves.toEqual(capabilities);
      expect(query).toHaveBeenCalledWith(input);
    }
  );

  it('normalizes older capabilities without inventing a default destination', async () => {
    mockCreateTRPCClient.mockReturnValueOnce({
      getSandboxSelectionOptions: {
        query: jest.fn(async () => ({
          enabled: true,
          options: [{ allocation: 'cloudflare-single', available: true }],
        })),
      },
    });
    await expect(
      new CloudAgentNextClient('auth-token').getSandboxSelectionOptions({ kilocodeOrganizationId })
    ).resolves.toEqual({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('cloudflare-single'), available: true }],
    });
  });

  it('does not turn capability failure into an available default', async () => {
    const error = new Error('Worker unavailable');
    mockCreateTRPCClient.mockReturnValueOnce({
      getSandboxSelectionOptions: {
        query: jest.fn(async () => {
          throw error;
        }),
      },
    });
    await expect(
      new CloudAgentNextClient('auth-token').getSandboxSelectionOptions({ kilocodeOrganizationId })
    ).rejects.toBe(error);
  });

  it('rejects invalid capability descriptors', async () => {
    mockCreateTRPCClient.mockReturnValueOnce({
      getSandboxSelectionOptions: {
        query: jest.fn(async () => ({
          enabled: true,
          options: [
            {
              allocation: {
                provider: { id: 'cloudflare', account: 'byoc' },
                instanceType: 'single',
              },
              available: true,
            },
          ],
        })),
      },
    });
    await expect(
      new CloudAgentNextClient('auth-token').getSandboxSelectionOptions({ kilocodeOrganizationId })
    ).rejects.toThrow();
  });

  it.each([
    undefined,
    'isolated-standard',
    'vercel-small',
    getSandboxAllocationRequest('cloudflare-shared'),
    getSandboxAllocationRequest('vercel-large'),
    { provider: { id: 'vercel', account: 'byoc' }, instanceType: 'small' },
  ] satisfies Array<SandboxAllocationInput | undefined>)(
    'forwards the prepare wire allocation unchanged: %j',
    async sandboxAllocation => {
      const input: PrepareSessionInput = {
        kilocodeOrganizationId,
        githubRepo: 'acme/repo',
        prompt: 'Build the feature',
        mode: 'code',
        model: 'kilo/test-model',
        operationKey: '12345678-1234-4234-9234-123456789abc',
        autoInitiate: true,
        ...(sandboxAllocation ? { sandboxAllocation } : {}),
      };
      const output = {
        kiloSessionId: 'ses_12345678901234567890123456',
        cloudAgentSessionId: 'agent_123',
        replayed: true,
      };
      const mutate = jest
        .fn<CloudAgentClientModule.CloudAgentNextClient['prepareSession']>()
        .mockResolvedValue(output);
      mockCreateTRPCClient.mockReturnValueOnce({ prepareSession: { mutate } });

      await expect(new CloudAgentNextClient('auth-token').prepareSession(input)).resolves.toEqual(
        output
      );
      expect(mutate).toHaveBeenCalledWith(input);
    }
  );
});

describe('CloudAgentNextClient sensitive error reporting', () => {
  const error = new Error('Worker unavailable');

  it('captures only safe prepare metadata without prompts, credentials, environment, or callback headers', async () => {
    const input = {
      prompt: 'private customer prompt',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'owner/repository',
      githubToken: 'github-token-secret',
      gitToken: 'git-token-secret',
      envVars: { API_KEY: 'environment-secret' },
      setupCommands: ['export PASSWORD=setup-secret'],
      mcpServers: {
        tools: {
          type: 'local',
          command: ['tool'],
          environment: { MCP_TOKEN: 'mcp-secret' },
        },
      },
      callbackTarget: {
        url: 'https://callback.example.test',
        headers: { Authorization: 'Bearer callback-secret' },
      },
      kilocodeOrganizationId: '9a283301-b75d-4375-a1ba-e319a02e18b7',
      operationKey: '12345678-1234-4234-9234-123456789abc',
      createdOnPlatform: 'cloud-agent-web',
      clientProvenance: 'browser',
    } satisfies PrepareSessionInput;
    const mutate = jest.fn(async () => {
      throw error;
    });
    mockCreateTRPCClient.mockReturnValueOnce({ prepareSession: { mutate } });

    await expect(new CloudAgentNextClient('auth-token').prepareSession(input)).rejects.toBe(error);

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'cloud-agent-next-client', endpoint: 'prepareSession' },
      extra: {
        kilocodeOrganizationId: input.kilocodeOrganizationId,
        cloneFromKiloSessionId: undefined,
        operationKey: input.operationKey,
        createdOnPlatform: input.createdOnPlatform,
        clientProvenance: input.clientProvenance,
        model: input.model,
        mode: input.mode,
      },
    });
    const captured = JSON.stringify(mockCaptureException.mock.calls);
    for (const sensitive of [
      'private customer prompt',
      'github-token-secret',
      'git-token-secret',
      'environment-secret',
      'setup-secret',
      'mcp-secret',
      'callback-secret',
      'auth-token',
    ]) {
      expect(captured).not.toContain(sensitive);
    }
  });

  it('captures only the session identity when prepared-session initiation fails', async () => {
    const mutate = jest.fn(async () => {
      throw error;
    });
    mockCreateTRPCClient.mockReturnValueOnce({ initiateFromKilocodeSessionV2: { mutate } });

    await expect(
      new CloudAgentNextClient('auth-token').initiateFromPreparedSession({
        cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
      })
    ).rejects.toBe(error);

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: {
        source: 'cloud-agent-next-client',
        endpoint: 'initiateFromPreparedSession',
      },
      extra: { cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc' },
    });
  });

  it('captures only message identities and payload type without prompt or Git credentials', async () => {
    const input = {
      cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
      messageId: 'msg_12345678901212345678901234',
      payload: {
        type: 'prompt',
        prompt: 'private follow-up prompt',
        mode: 'code',
        model: 'kilo/test-model',
      },
      githubToken: 'follow-up-github-secret',
      gitToken: 'follow-up-git-secret',
    } satisfies SendMessageInput;
    const mutate = jest.fn(async () => {
      throw error;
    });
    mockCreateTRPCClient.mockReturnValueOnce({ sendMessageV2: { mutate } });

    await expect(new CloudAgentNextClient('auth-token').sendMessage(input)).rejects.toBe(error);

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'cloud-agent-next-client', endpoint: 'sendMessage' },
      extra: {
        cloudAgentSessionId: input.cloudAgentSessionId,
        messageId: input.messageId,
        payloadType: 'prompt',
      },
    });
    const captured = JSON.stringify(mockCaptureException.mock.calls);
    expect(captured).not.toContain('private follow-up prompt');
    expect(captured).not.toContain('follow-up-github-secret');
    expect(captured).not.toContain('follow-up-git-secret');
    expect(captured).not.toContain('auth-token');
  });
});

describe('CloudAgentNextClient.getComputeBillingStatus', () => {
  type StatusQuery = (input: GetSessionInput) => Promise<ComputeBillingStatus>;
  const sessionId = 'agent_12345678-1234-4234-9234-123456789abc';
  const status: ComputeBillingStatus = {
    payer: { type: 'user', id: 'user-123' },
    attribution: 'session',
    phase: 'idle',
    estimatedHourlyRateMicrodollars: null,
    estimatedIntervalAmountMicrodollars: null,
    billingMode: null,
    interval: null,
  };
  const { TRPCClientError } = jest.requireActual<typeof TrpcClientModule>('@trpc/client');
  const connectionReset = () =>
    TRPCClientError.from(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      })
    );

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns successful status without retrying', async () => {
    const query = jest.fn<StatusQuery>().mockResolvedValue(status);
    mockCreateTRPCClient.mockReturnValueOnce({ getComputeBillingStatus: { query } });

    await expect(
      new CloudAgentNextClient('token').getComputeBillingStatus(sessionId)
    ).resolves.toBe(status);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ cloudAgentSessionId: sessionId });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries a nested connection reset once after a short delay', async () => {
    const query = jest
      .fn<StatusQuery>()
      .mockRejectedValueOnce(connectionReset())
      .mockResolvedValueOnce(status);
    mockCreateTRPCClient.mockReturnValueOnce({ getComputeBillingStatus: { query } });

    const result = new CloudAgentNextClient('token').getComputeBillingStatus(sessionId);
    await Promise.all([
      expect(result).resolves.toBe(status),
      (async () => {
        await jest.advanceTimersByTimeAsync(99);
        expect(query).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(101);
      })(),
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, { cloudAgentSessionId: sessionId });
    expect(query).toHaveBeenNthCalledWith(2, { cloudAgentSessionId: sessionId });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it.each([connectionReset(), new Error('Worker unavailable')])(
    'propagates the second failure unchanged without a third attempt: %s',
    async error => {
      const query = jest
        .fn<StatusQuery>()
        .mockRejectedValueOnce(connectionReset())
        .mockRejectedValueOnce(error);
      mockCreateTRPCClient.mockReturnValueOnce({ getComputeBillingStatus: { query } });

      const result = new CloudAgentNextClient('token').getComputeBillingStatus(sessionId);
      await Promise.all([expect(result).rejects.toBe(error), jest.runAllTimersAsync()]);

      expect(query).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it.each([
    new TRPCClientError('Forbidden', {
      result: {
        error: { code: -32003, message: 'Forbidden', data: { code: 'FORBIDDEN', httpStatus: 403 } },
      },
    }),
    new TypeError('fetch failed'),
    new Error('read ECONNRESET'),
    new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }),
    new Error('Malformed cause', { cause: 'ECONNRESET' }),
    null,
    undefined,
  ])('does not retry unrelated or unstructured errors: %s', async error => {
    const query = jest.fn<StatusQuery>().mockRejectedValue(error);
    mockCreateTRPCClient.mockReturnValueOnce({ getComputeBillingStatus: { query } });

    await expect(new CloudAgentNextClient('token').getComputeBillingStatus(sessionId)).rejects.toBe(
      error
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('terminates cause inspection for cyclic errors', async () => {
    const error = new Error('Cyclic cause');
    error.cause = error;
    const query = jest.fn<StatusQuery>().mockRejectedValue(error);
    mockCreateTRPCClient.mockReturnValueOnce({ getComputeBillingStatus: { query } });

    await expect(new CloudAgentNextClient('token').getComputeBillingStatus(sessionId)).rejects.toBe(
      error
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('CloudAgentNextClient.deleteSession', () => {
  const sessionId = 'workspace_12345678-1234-4234-9234-123456789abc';

  it('preserves typed Worker NOT_FOUND so ownership deletion can remain idempotent', async () => {
    const { TRPCClientError } = jest.requireActual<typeof TrpcClientModule>('@trpc/client');
    const error = new TRPCClientError('Runtime session not found', {
      result: {
        error: {
          code: -32004,
          message: 'Runtime session not found',
          data: { code: 'NOT_FOUND', httpStatus: 404 },
        },
      },
    });
    const mutate = jest.fn(async () => {
      throw error;
    });
    mockCreateTRPCClient.mockReturnValueOnce({ deleteSession: { mutate } });

    await expect(new CloudAgentNextClient('auth-token').deleteSession(sessionId)).rejects.toBe(
      error
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('continues returning failed runtime deletion for genuine Worker failures', async () => {
    const error = new Error('Worker unavailable');
    const mutate = jest.fn(async () => {
      throw error;
    });
    mockCreateTRPCClient.mockReturnValueOnce({ deleteSession: { mutate } });

    await expect(new CloudAgentNextClient('auth-token').deleteSession(sessionId)).resolves.toEqual({
      success: false,
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'cloud-agent-next-client', endpoint: 'deleteSession' },
      extra: { sessionId },
    });
  });

  it('preserves an explicit unsuccessful Worker deletion response', async () => {
    const mutate = jest.fn(async () => ({ success: false }));
    mockCreateTRPCClient.mockReturnValueOnce({ deleteSession: { mutate } });

    await expect(new CloudAgentNextClient('auth-token').deleteSession(sessionId)).resolves.toEqual({
      success: false,
    });
  });
});

describe('CloudAgentNextClient.deleteWorktree', () => {
  const worktreeId = 'worktree_12345678-1234-4234-9234-123456789abc';
  const deletedSessionIds = ['ses_12345678901234567890123456', 'ses_abcdefghijklmnopqrstuvwxyz'];

  it.each([undefined, '9a283301-b75d-4375-a1ba-e319a02e18b7'])(
    'forwards the exact scope and authenticates the Worker request: %p',
    async kilocodeOrganizationId => {
      const input: DeleteWorktreeInput = {
        worktreeId,
        ...(kilocodeOrganizationId ? { kilocodeOrganizationId } : {}),
      };
      const mutate = jest
        .fn<(request: DeleteWorktreeInput) => Promise<DeleteWorktreeOutput>>()
        .mockResolvedValue({ success: true, deletedSessionIds });
      mockCreateTRPCClient.mockReturnValueOnce({ deleteWorktree: { mutate } });
      const client = new CloudAgentNextClient('auth-token');

      await expect(client.deleteWorktree(input)).resolves.toEqual({
        success: true,
        deletedSessionIds,
      });
      expect(mutate).toHaveBeenCalledWith(input);
      expect(mockHttpLink.mock.calls[0]?.[0].headers()).toEqual({
        Authorization: 'Bearer auth-token',
        'x-internal-api-key': 'test-secret',
      });
    }
  );

  it.each([
    ['CONFLICT', 409],
    ['SERVICE_UNAVAILABLE', 503],
    ['NOT_FOUND', 404],
    ['FORBIDDEN', 403],
  ])('preserves the original typed Worker %s error', async (code, httpStatus) => {
    const { TRPCClientError } = jest.requireActual<typeof TrpcClientModule>('@trpc/client');
    const error = new TRPCClientError('worktree_deletion_pending', {
      result: {
        error: {
          code: -32000,
          message: 'worktree_deletion_pending',
          data: { code, httpStatus },
        },
      },
    });
    const mutate = jest.fn(async () => {
      throw error;
    });
    mockCreateTRPCClient.mockReturnValueOnce({ deleteWorktree: { mutate } });

    await expect(
      new CloudAgentNextClient('auth-token').deleteWorktree({ worktreeId })
    ).rejects.toBe(error);
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'cloud-agent-next-client', endpoint: 'deleteWorktree' },
      extra: { worktreeId },
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain('auth-token');
  });

  it('propagates transport failures rather than returning a false success', async () => {
    const error = new Error('Worker unavailable');
    mockCreateTRPCClient.mockReturnValueOnce({
      deleteWorktree: {
        mutate: jest.fn(async () => {
          throw error;
        }),
      },
    });
    await expect(
      new CloudAgentNextClient('auth-token').deleteWorktree({ worktreeId })
    ).rejects.toBe(error);
  });

  it.each([
    { success: false, deletedSessionIds: [] },
    { success: true },
    { success: true, deletedSessionIds: [42] },
  ])('rejects an unconfirmed or malformed cleanup result: %p', async output => {
    mockCreateTRPCClient.mockReturnValueOnce({
      deleteWorktree: { mutate: jest.fn(async () => output) },
    });
    await expect(
      new CloudAgentNextClient('auth-token').deleteWorktree({ worktreeId })
    ).rejects.toThrow();
  });

  it('returns only the public cleanup result and preserves empty idempotent responses', async () => {
    mockCreateTRPCClient.mockReturnValueOnce({
      deleteWorktree: {
        mutate: jest.fn(async () => ({
          success: true,
          deletedSessionIds: [],
          runtimeLocations: [{ workspacePath: '/private/worktree' }],
        })),
      },
    });
    await expect(
      new CloudAgentNextClient('auth-token').deleteWorktree({ worktreeId })
    ).resolves.toEqual({
      success: true,
      deletedSessionIds: [],
    });
  });
});

describe('CloudAgentNextClient.createWorktreeChat', () => {
  it('forwards the exact authenticated Worker operation and preserves replay identity', async () => {
    const uuid = '12345678-1234-4234-9234-123456789abc';
    const input = {
      sourceKiloSessionId: 'ses_12345678901234567890123456',
      sourceCloudAgentSessionId: `workspace_${uuid}`,
      operationKey: uuid,
      kilocodeOrganizationId: '9a283301-b75d-4375-a1ba-e319a02e18b7',
      clientProvenance: 'browser',
    } satisfies CreateWorktreeChatInput;
    const output = {
      kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
      cloudAgentSessionId: `workspace_${uuid}`,
      worktreeId: `worktree_${uuid}`,
      replayed: true,
    } satisfies CreateWorktreeChatOutput;
    const mutate = jest
      .fn<(request: CreateWorktreeChatInput) => Promise<CreateWorktreeChatOutput>>()
      .mockResolvedValue(output);
    mockCreateTRPCClient.mockReturnValueOnce({ createWorktreeChat: { mutate } });

    await expect(new CloudAgentNextClient('token').createWorktreeChat(input)).resolves.toEqual(
      output
    );
    expect(mutate).toHaveBeenCalledWith(input);
  });
});

describe('CloudAgentNextClient.getSandboxStatus', () => {
  const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
  const snapshot = {
    status: 'active',
    provider: 'Cloudflare',
    observedAt: 1_800_000_000_000,
    detailCode: 'sandbox_ready',
    inactivityTimeoutMs: 300_000,
    estimatedSleepAt: 1_800_000_060_000,
  } satisfies SandboxStatusSnapshot;
  const query = jest.fn<(input: { cloudAgentSessionId: string }) => Promise<unknown>>();
  const { CloudAgentNextClient } =
    jest.requireActual<typeof CloudAgentClientModule>('./cloud-agent-client');
  let client: InstanceType<typeof CloudAgentNextClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset().mockResolvedValue(snapshot);
    jest.mocked(createTRPCClient).mockReturnValue({ getSandboxStatus: { query } } as never);
    client = new CloudAgentNextClient('test-token');
  });

  it('uses the existing transport and returns only the validated public snapshot', async () => {
    query.mockResolvedValue({
      ...snapshot,
      sandboxId: 'private-sandbox',
      providerInstanceId: 'private-instance',
      ownerId: 'private-owner',
      headers: { authorization: 'private-token' },
      error: 'private-diagnostics',
    });
    const response = await client.getSandboxStatus(cloudAgentSessionId);
    expect(query).toHaveBeenCalledWith({ cloudAgentSessionId });
    expect(response).toEqual(snapshot);
    expect(JSON.stringify(response)).not.toContain('private');
  });

  it.each([
    null,
    {},
    { ...snapshot, status: 'private-status' },
    { ...snapshot, provider: 'private-provider' },
    { ...snapshot, detailCode: 'private-details' },
    { ...snapshot, observedAt: Infinity },
    { ...snapshot, inactivityTimeoutMs: 0 },
    { ...snapshot, estimatedSleepAt: snapshot.observedAt },
  ])('bounds malformed Worker data without reporting raw diagnostics: %j', async response => {
    query.mockResolvedValue(response);
    const result = await client.getSandboxStatus(cloudAgentSessionId);
    expect(result).toEqual({
      status: 'unknown',
      provider: 'Unknown',
      observedAt: expect.any(Number),
      detailCode: 'status_unavailable',
      inactivityTimeoutMs: null,
      estimatedSleepAt: null,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([
    new Error('private-network-diagnostics'),
    new SyntaxError('private-upstream-html is not valid JSON'),
    new TRPCClientError('private-infrastructure-error'),
  ])('makes transport failures observation-unavailable without logging the cause', async error => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      query.mockRejectedValue(error);
      const result = await client.getSandboxStatus(cloudAgentSessionId);
      expect(result).toMatchObject({ status: 'unknown', detailCode: 'status_unavailable' });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(captureException).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    { data: { code: 'UNAUTHORIZED', httpStatus: 401 }, expectedCode: 'UNAUTHORIZED' },
    { data: { code: 'FORBIDDEN', httpStatus: 403 }, expectedCode: 'FORBIDDEN' },
    { data: { code: 'NOT_FOUND', httpStatus: 404 }, expectedCode: 'FORBIDDEN' },
    { data: { httpStatus: 401 }, expectedCode: 'UNAUTHORIZED' },
    { data: { httpStatus: 403 }, expectedCode: 'FORBIDDEN' },
    { data: { httpStatus: 404 }, expectedCode: 'FORBIDDEN' },
  ])('preserves a sanitized denial for $data', async ({ data, expectedCode }) => {
    query.mockRejectedValue(
      Object.assign(new TRPCClientError('private-access-diagnostics'), { data })
    );
    await expect(client.getSandboxStatus(cloudAgentSessionId)).rejects.toMatchObject({
      code: expectedCode,
      message:
        expectedCode === 'UNAUTHORIZED'
          ? 'Authentication required'
          : 'Session not found or access denied',
      cause: undefined,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does not turn unavailable Worker authorization storage into a successful snapshot', async () => {
    query.mockRejectedValue(
      Object.assign(new TRPCClientError('private-authorization-storage-diagnostics'), {
        data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 },
      })
    );
    await expect(client.getSandboxStatus(cloudAgentSessionId)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Sandbox status is temporarily unavailable',
      cause: undefined,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('also preserves denials supplied on the tRPC error shape', async () => {
    query.mockRejectedValue(
      Object.assign(new TRPCClientError('private-access-diagnostics'), {
        shape: { data: { code: 'FORBIDDEN', httpStatus: 403 } },
      })
    );
    await expect(client.getSandboxStatus(cloudAgentSessionId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Session not found or access denied',
      cause: undefined,
    });
  });
});

describe('closeCloudAgentOrgStreams', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs to the close endpoint with the internal key header and body', async () => {
    const fetchMock = jest
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await closeCloudAgentOrgStreams('usr_1', 'org_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://cloud-agent-next/internal/streams/close',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-secret',
        },
        body: JSON.stringify({ userId: 'usr_1', organizationId: 'org_1' }),
      })
    );
  });

  it('throws when the close endpoint returns a non-OK response', async () => {
    const fetchMock = jest
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response('boom', { status: 500, statusText: 'Internal Server Error' })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(closeCloudAgentOrgStreams('usr_1', 'org_1')).rejects.toThrow(
      'Cloud Agent stream close failed: 500 Internal Server Error - boom'
    );
  });
});
