import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostMessageAsUserParams, PostMessageAsUserResult } from '@kilocode/kilo-chat';

// Mock module-level imports before importing the unit under test. These mocks
// stand in for: DB lookup of sandbox id, the kilo-chat service binding cast
// helper, and the durable-object retry wrapper. Logger and prompt-template
// are left unmocked because they are pure and side-effect-free.
const mockFindActiveSandboxIdForInstance =
  vi.fn<(db: unknown, instanceId: string, userId: string) => Promise<string | null>>();
const mockPostMessageAsUser =
  vi.fn<(params: PostMessageAsUserParams) => Promise<PostMessageAsUserResult>>();

vi.mock('./db/queries', () => ({
  findActiveSandboxIdForInstance: (db: unknown, instanceId: string, userId: string) =>
    mockFindActiveSandboxIdForInstance(db, instanceId, userId),
  getWorkerDb: () => ({}),
}));

vi.mock('./kilo-chat-binding', () => ({
  getKiloChat: () => ({
    postMessageAsUser: (params: PostMessageAsUserParams) => mockPostMessageAsUser(params),
  }),
}));

// withDORetry: run the operation once with the stub. Tests do not exercise
// retry behaviour for these branches; they verify status-flip invariants.
vi.mock('./util/do-retry', () => ({
  withDORetry: async <Stub, T>(
    getStub: () => Stub,
    op: (stub: Stub) => Promise<T>,
    _label: string
  ): Promise<T> => op(getStub()),
}));

import { handleWebhookDeliveryBatch, processKiloclawChatMessage } from './queue-consumer';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';

type UpdateCall = { requestId: string; patch: Record<string, unknown> };

function makeStub() {
  const updateCalls: UpdateCall[] = [];
  const stub = {
    updateRequest: vi.fn(async (requestId: string, patch: Record<string, unknown>) => {
      updateCalls.push({ requestId, patch });
    }),
  };
  return { stub: stub as unknown as DurableObjectStub<never>, updateCalls };
}

function makeWebhook() {
  return {
    namespace: 'user/user-1',
    triggerId: 'trigger-1',
    requestId: 'req-1',
  };
}

function makeRequest(processStatus = 'captured') {
  return {
    body: '{}',
    method: 'POST',
    path: '/inbound/user/user-1/trigger-1',
    headers: { 'content-type': 'application/json' },
    queryString: null,
    sourceIp: null,
    timestamp: '2026-05-08T12:00:00Z',
    processStatus,
  };
}

function makeTriggerConfig(overrides: Record<string, unknown> = {}) {
  return {
    triggerId: 'trigger-1',
    userId: 'user-1',
    orgId: null,
    targetType: 'kiloclaw_chat',
    kiloclawInstanceId: 'instance-uuid-1',
    promptTemplate: 'Webhook says: {{body}}',
    isActive: true,
    profileId: null,
    githubRepo: null,
    activationMode: 'always_on',
    cronExpression: null,
    cronTimezone: 'UTC',
    ...overrides,
  } as unknown as Parameters<typeof processKiloclawChatMessage>[3];
}

function makeEnv() {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    KILO_CHAT: {} as unknown,
  } as unknown as Env;
}

describe('processKiloclawChatMessage', () => {
  beforeEach(() => {
    mockFindActiveSandboxIdForInstance.mockReset();
    mockPostMessageAsUser.mockReset();
  });

  it('flips status to failed when the instance lookup returns null', async () => {
    mockFindActiveSandboxIdForInstance.mockResolvedValue(null);
    const { stub, updateCalls } = makeStub();

    await processKiloclawChatMessage(
      stub,
      makeWebhook(),
      makeRequest(),
      makeTriggerConfig(),
      makeEnv()
    );

    // No inprogress mark because the lookup failed before that step.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toMatchObject({ process_status: 'failed' });
    expect(updateCalls[0].patch.error_message).toContain('instance not found or destroyed');
    expect(mockPostMessageAsUser).not.toHaveBeenCalled();
  });

  it('flips inprogress → failed when the kilo-chat RPC throws', async () => {
    mockFindActiveSandboxIdForInstance.mockResolvedValue('sandbox-1');
    mockPostMessageAsUser.mockRejectedValue(new Error('service binding outage'));
    const { stub, updateCalls } = makeStub();

    await processKiloclawChatMessage(
      stub,
      makeWebhook(),
      makeRequest(),
      makeTriggerConfig(),
      makeEnv()
    );

    // Two updates: inprogress, then failed (the critical invariant).
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].patch).toMatchObject({ process_status: 'inprogress' });
    expect(updateCalls[1].patch).toMatchObject({ process_status: 'failed' });
    expect(updateCalls[1].patch.error_message).toContain('service binding outage');
  });

  it('flips inprogress → failed when the kilo-chat RPC returns ok: false', async () => {
    mockFindActiveSandboxIdForInstance.mockResolvedValue('sandbox-1');
    const errResult: PostMessageAsUserResult = {
      ok: false,
      code: 'forbidden',
      error: 'You do not have access to this sandbox',
    };
    mockPostMessageAsUser.mockResolvedValue(errResult);
    const { stub, updateCalls } = makeStub();

    await processKiloclawChatMessage(
      stub,
      makeWebhook(),
      makeRequest(),
      makeTriggerConfig(),
      makeEnv()
    );

    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].patch).toMatchObject({ process_status: 'inprogress' });
    expect(updateCalls[1].patch).toMatchObject({ process_status: 'failed' });
    expect(updateCalls[1].patch.error_message).toContain('You do not have access');
  });

  it('flips inprogress → success and forwards correlation on the happy path', async () => {
    mockFindActiveSandboxIdForInstance.mockResolvedValue('sandbox-1');
    const okResult: PostMessageAsUserResult = {
      ok: true,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      conversationCreated: true,
    };
    mockPostMessageAsUser.mockResolvedValue(okResult);
    const { stub, updateCalls } = makeStub();

    await processKiloclawChatMessage(
      stub,
      makeWebhook(),
      makeRequest(),
      makeTriggerConfig(),
      makeEnv()
    );

    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].patch).toMatchObject({ process_status: 'inprogress' });
    expect(updateCalls[1].patch).toMatchObject({ process_status: 'success' });

    // Source tag and correlation are passed through for log attribution.
    expect(mockPostMessageAsUser).toHaveBeenCalledTimes(1);
    const args = mockPostMessageAsUser.mock.calls[0][0];
    expect(args.source).toBe('webhook');
    expect(args.correlation).toEqual({
      triggerId: 'trigger-1',
      webhookRequestId: 'req-1',
    });
    expect(args.userId).toBe('user-1');
    expect(args.sandboxId).toBe('sandbox-1');
    expect(args.autoCreateConversation).toBe(true);
  });

  it('skips when the request was already processed (idempotency guard)', async () => {
    const { stub, updateCalls } = makeStub();

    await processKiloclawChatMessage(
      stub,
      makeWebhook(),
      makeRequest('success'),
      makeTriggerConfig(),
      makeEnv()
    );

    expect(updateCalls).toHaveLength(0);
    expect(mockFindActiveSandboxIdForInstance).not.toHaveBeenCalled();
    expect(mockPostMessageAsUser).not.toHaveBeenCalled();
  });

  it('fails fast when the trigger has no kiloclawInstanceId configured', async () => {
    const { stub, updateCalls } = makeStub();

    await processKiloclawChatMessage(
      stub,
      makeWebhook(),
      makeRequest(),
      makeTriggerConfig({ kiloclawInstanceId: null }),
      makeEnv()
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toMatchObject({ process_status: 'failed' });
    expect(updateCalls[0].patch.error_message).toContain('instance ID not configured');
    expect(mockFindActiveSandboxIdForInstance).not.toHaveBeenCalled();
  });

  it('rejects org-scoped triggers (kiloclaw chat is user-scoped only)', async () => {
    const { stub, updateCalls } = makeStub();

    await processKiloclawChatMessage(
      stub,
      makeWebhook(),
      makeRequest(),
      makeTriggerConfig({ userId: null, orgId: 'org-1' }),
      makeEnv()
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toMatchObject({ process_status: 'failed' });
    expect(updateCalls[0].patch.error_message).toContain('user-scoped');
    expect(mockFindActiveSandboxIdForInstance).not.toHaveBeenCalled();
  });
});

describe('handleWebhookDeliveryBatch Cloud Agent callback target', () => {
  it('stores scoped callback token instead of raw internal API key', async () => {
    const internalSecret = 'test-internal-secret';
    const callbackTokenSecret = 'test-callback-token-secret';
    const webhook = makeWebhook();
    const prepareRequests: Request[] = [];
    const ack = vi.fn();
    const retry = vi.fn();
    const stub = {
      getRequest: vi.fn(async () => makeRequest()),
      getConfig: vi.fn(async () =>
        makeTriggerConfig({
          targetType: 'cloud_agent',
          mode: 'code',
          model: 'model-1',
          githubRepo: 'owner/repo',
          profileId: 'profile-1',
        })
      ),
      updateRequest: vi.fn(async () => ({ success: true })),
    };
    const env = {
      WEBHOOK_AGENT_URL: 'https://hooks.test',
      WEBHOOK_TOKEN_CACHE: {
        get: vi.fn(async () => 'api-token'),
        put: vi.fn(async () => undefined),
      },
      INTERNAL_API_SECRET: { get: vi.fn(async () => internalSecret) },
      CALLBACK_TOKEN_SECRET: { get: vi.fn(async () => callbackTokenSecret) },
      TRIGGER_DO: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => stub),
      },
      CLOUD_AGENT: {
        fetch: vi.fn(async (request: Request) => {
          if (request.url.includes('/trpc/prepareSession')) {
            prepareRequests.push(request);
            return Response.json({
              result: { data: { cloudAgentSessionId: 'cloud-session-1' } },
            });
          }

          return Response.json({
            result: { data: { executionId: 'execution-1', status: 'running' } },
          });
        }),
      },
    } as unknown as Env;
    const batch = {
      queue: 'webhook-delivery',
      messages: [{ body: webhook, attempts: 1, ack, retry }],
    } as unknown as MessageBatch<ReturnType<typeof makeWebhook>>;

    await handleWebhookDeliveryBatch(batch, env);

    const prepareBody = await prepareRequests[0]?.json();
    const expectedToken = await deriveCallbackToken({
      secret: callbackTokenSecret,
      scope: 'webhook-execution-callback',
      resourceParts: [webhook.namespace, webhook.triggerId, webhook.requestId],
    });
    expect(prepareBody).toMatchObject({
      callbackTarget: {
        url: 'https://hooks.test/api/callbacks/execution',
        headers: {
          'X-Callback-Token': expectedToken,
          'x-webhook-namespace': webhook.namespace,
          'x-webhook-trigger-id': webhook.triggerId,
          'x-webhook-request-id': webhook.requestId,
        },
      },
    });
    expect(prepareBody).not.toMatchObject({
      callbackTarget: { headers: { 'x-internal-api-key': expect.any(String) } },
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
