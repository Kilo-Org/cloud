import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';

import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';
import type { CustomerBillingFailure, SessionMessageAdmissionResult } from '../execution/types.js';
import { QUEUED_MESSAGE_LIMIT } from '../control-plane/session/messages.js';

vi.mock('./session-id-guard.js', async () => {
  const { TRPCError } = await import('@trpc/server');
  return {
    assertControlSessionId: (sessionId: string): void => {
      if (!sessionId.startsWith('workspace_')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only workspace sessions are supported',
        });
      }
    },
  };
});

vi.mock('./model-preflight.js', () => ({
  preflightExistingPromptModel: vi.fn(),
  preflightSessionRuntime: vi.fn(),
}));

const fetchSessionMetadata = vi.hoisted(() => vi.fn());

vi.mock('./metadata.js', () => ({ fetchSessionMetadata }));

vi.mock('../auth.js', () => ({
  resolveSecret: vi.fn(async () => 'secret'),
}));

vi.mock('@kilocode/worker-utils/runtime-authorization', () => ({
  createRuntimeAuthorization: vi.fn(async () => ({
    authorization: { id: 'authorization-1' },
    token: 'runtime-token',
  })),
  sealRuntimeAuthorization: vi.fn(async () => 'runtime-seal'),
}));

vi.mock('../execution/attachment-prompt-parts.js', () => ({
  buildSignedPromptAttachments: vi.fn(async () => []),
}));

import {
  pendingQueueFullAdmissionFailure,
  preflightAndQueuePromptMessage,
  preflightRuntimeAuthorizationRecovery,
  projectAdmissionToPublicAck,
  queueMessage,
  throwAdmissionError,
  type QueueMessageInput,
} from './queue-message.js';
import { preflightExistingPromptModel, preflightSessionRuntime } from './model-preflight.js';

const metadata = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
    userId: 'user_abc',
    createdOnPlatform: 'cloud-agent-web',
  },
  agent: { mode: 'code', model: 'test/model' },
} as unknown as SessionMetadata;

function makeEnv(stub: unknown): Env {
  return {
    SANDBOX_SESSION: {
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      get: vi.fn(() => stub),
    },
  } as unknown as Env;
}

function makeSend(result: unknown) {
  return vi.fn().mockResolvedValue(result);
}

const promptInput: QueueMessageInput = {
  cloudAgentSessionId: 'workspace_existing',
  turn: { type: 'prompt', prompt: 'follow up' },
};

beforeEach(() => {
  vi.mocked(fetchSessionMetadata).mockReset().mockResolvedValue(metadata);
  vi.mocked(preflightExistingPromptModel).mockReset().mockResolvedValue(undefined);
  vi.mocked(preflightSessionRuntime).mockReset().mockResolvedValue(undefined);
});

describe('preflightAndQueuePromptMessage', () => {
  it('runs stored-session, runtime-authorization and model preflight before the send RPC', async () => {
    const send = makeSend({ type: 'ok' });
    const env = makeEnv({ send }) as Env;

    await expect(
      preflightAndQueuePromptMessage(
        {
          ...promptInput,
          turn: { type: 'prompt', id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn', prompt: 'follow up' },
          agent: { model: 'kilo/anthropic/claude-sonnet-4' },
        },
        { env, userId: 'user_abc' },
        'send'
      )
    ).resolves.toMatchObject({
      delivery: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });

    expect(preflightSessionRuntime).toHaveBeenCalledWith({
      env,
      userId: 'user_abc',
      cloudAgentSessionId: 'workspace_existing',
      procedure: 'send',
    });
    expect(preflightExistingPromptModel).toHaveBeenCalledWith({
      env,
      userId: 'user_abc',
      cloudAgentSessionId: 'workspace_existing',
      requestedModel: 'kilo/anthropic/claude-sonnet-4',
      procedure: 'send',
    });
    expect(vi.mocked(preflightExistingPromptModel).mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects a non-workspace ID before metadata or preflight', async () => {
    const send = makeSend({ type: 'ok' });

    await expect(
      preflightAndQueuePromptMessage(
        { ...promptInput, cloudAgentSessionId: 'agent_existing' },
        { env: makeEnv({ send }) as Env, userId: 'user_abc' },
        'send'
      )
    ).rejects.toBeInstanceOf(TRPCError);

    expect(fetchSessionMetadata).not.toHaveBeenCalled();
    expect(preflightSessionRuntime).not.toHaveBeenCalled();
    expect(preflightExistingPromptModel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('queueMessage', () => {
  it('admits through the V2 send RPC and projects a queued acknowledgment', async () => {
    const send = makeSend({ type: 'ok' });
    const env = makeEnv({ send }) as Env;

    const response = await queueMessage(
      {
        ...promptInput,
        turn: { type: 'prompt', prompt: 'hello' },
      },
      { env, userId: 'user_abc' }
    );

    expect(response).toMatchObject({
      cloudAgentSessionId: 'workspace_existing',
      status: 'started',
      delivery: 'queued',
      streamUrl: '/stream?cloudAgentSessionId=workspace_existing',
    });
    expect(response.messageId).toMatch(/^msg_/);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: response.messageId,
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code', model: 'test/model' },
      })
    );
  });

  it.each(['prompt', 'command'] as const)(
    'reuses an omitted %s ID across a lost send response',
    async type => {
      const sent: string[] = [];
      let attempts = 0;
      const send = vi.fn(async (payload: { messageId: string }) => {
        sent.push(payload.messageId);
        attempts += 1;
        if (attempts === 1)
          throw Object.assign(new Error('Response lost after admission'), { retryable: true });
        return { type: 'ok' as const };
      });

      const response = await queueMessage(
        {
          cloudAgentSessionId: 'workspace_existing',
          turn:
            type === 'prompt'
              ? { type, prompt: 'hello' }
              : { type, command: 'review', arguments: '--all' },
        },
        { env: makeEnv({ send }) as Env, userId: 'user_abc' }
      );

      expect(attempts).toBe(2);
      expect(new Set(sent).size).toBe(1);
      expect(sent[0]).toBe(response.messageId);
    }
  );

  it('forwards the caller messageId when provided', async () => {
    const send = makeSend({ type: 'ok' });

    await queueMessage(
      {
        ...promptInput,
        turn: { type: 'prompt', id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn', prompt: 'hello' },
      },
      { env: makeEnv({ send }) as Env, userId: 'user_a' }
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn' })
    );
  });

  it('forwards the composed canonical message payload to the Durable Object', async () => {
    const send = makeSend({ type: 'ok' });

    await queueMessage(
      {
        cloudAgentSessionId: 'workspace_payload',
        turn: {
          type: 'prompt',
          prompt: 'inspect the screenshot',
          attachments: {
            path: '123e4567-e89b-12d3-a456-426614174000',
            files: ['123e4567-e89b-12d3-a456-426614174001.png'],
          },
        },
        agent: { mode: 'plan', model: 'queued-model', variant: 'thinking' },
        finalization: { autoCommit: true, condenseOnComplete: false },
      },
      { env: makeEnv({ send }) as Env, userId: 'user_payload', botId: 'bot_payload' }
    );

    expect(send).toHaveBeenCalledWith({
      messageId: expect.stringMatching(/^msg_/),
      turn: {
        type: 'prompt',
        prompt: 'inspect the screenshot',
      },
      agent: { mode: 'plan', model: 'queued-model', variant: 'thinking' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });
  });

  it('maps a V2 session-not-found send to 404', async () => {
    const send = makeSend({ type: 'session-not-found' });

    await expect(
      queueMessage(promptInput, { env: makeEnv({ send }) as Env, userId: 'u' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Session not found' });
  });

  it('maps a V2 queue-full send to the retryable 429 PENDING_QUEUE_FULL', async () => {
    const send = makeSend({ type: 'queue-full' });

    const error = await queueMessage(promptInput, {
      env: makeEnv({ send }) as Env,
      userId: 'user_abc',
    }).catch(error => error);

    expect(error).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: `Pending message queue is full (${QUEUED_MESSAGE_LIMIT})`,
      cause: { error: 'PENDING_QUEUE_FULL', retryable: true },
    });
  });

  it('returns NOT_FOUND when stored metadata is missing', async () => {
    vi.mocked(fetchSessionMetadata).mockResolvedValue(null);
    const send = makeSend({ type: 'ok' });

    await expect(
      queueMessage(promptInput, { env: makeEnv({ send }) as Env, userId: 'user_abc' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Session not found' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a non-workspace ID before metadata or the send RPC', async () => {
    const send = makeSend({ type: 'ok' });

    await expect(
      queueMessage(
        { ...promptInput, cloudAgentSessionId: 'agent_x' as SessionId },
        { env: makeEnv({ send }) as Env, userId: 'u' }
      )
    ).rejects.toBeInstanceOf(TRPCError);

    expect(fetchSessionMetadata).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('projectAdmissionToPublicAck', () => {
  it('projects an already runtime-accepted replay as sent at the public seam', () => {
    expect(
      projectAdmissionToPublicAck('workspace_y' as SessionId, {
        success: true,
        outcome: 'queued',
        compatibilityDelivery: 'sent',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      })
    ).toMatchObject({ status: 'started', delivery: 'sent' });
  });
});

describe('throwAdmissionError', () => {
  function capture(result: Extract<SessionMessageAdmissionResult, { success: false }>): TRPCError {
    try {
      throwAdmissionError(result);
    } catch (error) {
      if (error instanceof TRPCError) return error;
      throw error;
    }
    throw new Error('expected throwAdmissionError to throw');
  }

  it('maps NOT_FOUND and BAD_REQUEST to permanent client errors', () => {
    expect(capture({ success: false, code: 'NOT_FOUND', error: 'gone' })).toMatchObject({
      code: 'NOT_FOUND',
      cause: { error: 'NOT_FOUND', retryable: false },
    });
    expect(capture({ success: false, code: 'BAD_REQUEST', error: 'nope' })).toMatchObject({
      code: 'BAD_REQUEST',
      cause: { error: 'BAD_REQUEST', retryable: false },
    });
  });

  it.each([
    ['PAYMENT_REQUIRED', 'PAYMENT_REQUIRED', 'INSUFFICIENT_CREDITS', false],
    ['COMPUTE_STOPPING', 'CONFLICT', 'COMPUTE_STOPPING', true],
    ['BILLING_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'BILLING_UNAVAILABLE', true],
  ] as const)(
    'preserves %s billing failure details and retryability',
    (resultCode, trpcCode, billingCode, retryable) => {
      const billingFailure: CustomerBillingFailure = {
        code: billingCode,
        payer: { type: 'org', id: 'org_abc' },
        retryable,
        remainingMicrodollars: 1,
        minimumRequiredMicrodollars: 5,
      };

      expect(
        capture({
          success: false,
          code: resultCode,
          error: 'Compute billing rejected admission',
          billingFailure,
          failureBoundary: 'admission',
        })
      ).toMatchObject({
        code: trpcCode,
        cause: { error: resultCode, retryable, billingFailure },
      });
    }
  );

  it('maps PENDING_QUEUE_FULL to a retryable TOO_MANY_REQUESTS error', () => {
    expect(capture(pendingQueueFullAdmissionFailure())).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: `Pending message queue is full (${QUEUED_MESSAGE_LIMIT})`,
      cause: { error: 'PENDING_QUEUE_FULL', retryable: true },
    });
  });

  it('maps INTERNAL to an explicitly retryable 500 error', () => {
    expect(capture({ success: false, code: 'INTERNAL', error: 'boom' })).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'boom',
      cause: { error: 'INTERNAL', retryable: true },
    });
  });

  it('maps retryable SANDBOX_CONNECT_FAILED to SERVICE_UNAVAILABLE', () => {
    expect(
      capture({ success: false, code: 'SANDBOX_CONNECT_FAILED', error: 'transient' })
    ).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'transient',
      cause: { error: 'SANDBOX_CONNECT_FAILED', retryable: true },
    });
  });
});

describe('preflightRuntimeAuthorizationRecovery', () => {
  const currentAuthToken = jwt.sign({ tokenPurpose: 'cloud-agent' }, 'test-secret');
  const recoverExpiredRuntimeAuthorization = vi.fn();

  function authEnv(state: unknown) {
    const stub = {
      getRuntimeAuthorizationStatus: vi.fn().mockResolvedValue(state),
      recoverExpiredRuntimeAuthorization,
    };
    return {
      ...makeEnv(stub),
      HYPERDRIVE: { connectionString: 'postgres://test' },
    } as unknown as Env;
  }

  beforeEach(() => {
    recoverExpiredRuntimeAuthorization.mockReset().mockResolvedValue({ status: 'recovered' });
  });

  it('does nothing for an active authorization', async () => {
    await preflightRuntimeAuthorizationRecovery('workspace_a', {
      env: authEnv({ state: 'active', id: 'authorization-1' }),
      userId: 'user_abc',
      authToken: currentAuthToken,
    });

    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
  });

  it('does nothing for the legacy credential-compatibility status', async () => {
    const env = authEnv({ state: 'legacy' });

    await expect(
      preflightRuntimeAuthorizationRecovery('workspace_legacy', {
        env,
        userId: 'user_abc',
        authToken: currentAuthToken,
      })
    ).resolves.toBeUndefined();

    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
  });

  it('rejects a revoked authorization with FORBIDDEN', async () => {
    await expect(
      preflightRuntimeAuthorizationRecovery('workspace_a', {
        env: authEnv({ state: 'revoked' }),
        userId: 'user_abc',
        authToken: currentAuthToken,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  });

  it('mints and commits a fresh authorization when the delegation expired', async () => {
    await preflightRuntimeAuthorizationRecovery('workspace_a', {
      env: authEnv({ state: 'expired', id: 'authorization-1' }),
      userId: 'user_abc',
      authToken: currentAuthToken,
    });

    expect(recoverExpiredRuntimeAuthorization).toHaveBeenCalledWith({
      ownerId: 'user_abc',
      expectedOldId: 'authorization-1',
      runtimeAuthorizationSeal: 'runtime-seal',
      runtimeToken: 'runtime-token',
    });
  });

  it('maps a denied recovery to FORBIDDEN', async () => {
    recoverExpiredRuntimeAuthorization.mockResolvedValue({ status: 'denied' });

    await expect(
      preflightRuntimeAuthorizationRecovery('workspace_a', {
        env: authEnv({ state: 'expired', id: 'authorization-1' }),
        userId: 'user_abc',
        authToken: currentAuthToken,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('maps a busy or retry recovery to CONFLICT', async () => {
    recoverExpiredRuntimeAuthorization.mockResolvedValue({ status: 'busy' });

    await expect(
      preflightRuntimeAuthorizationRecovery('workspace_a', {
        env: authEnv({ state: 'expired', id: 'authorization-1' }),
        userId: 'user_abc',
        authToken: currentAuthToken,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a non-workspace ID before reading runtime authorization', async () => {
    const env = authEnv({ state: 'active' });
    const getSession = vi.spyOn(env.SANDBOX_SESSION, 'get');

    await expect(
      preflightRuntimeAuthorizationRecovery('agent_existing', {
        env,
        userId: 'user_abc',
        authToken: currentAuthToken,
      })
    ).rejects.toBeInstanceOf(TRPCError);

    expect(getSession).not.toHaveBeenCalled();
  });
});
