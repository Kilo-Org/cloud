import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  preflightAndQueuePromptMessage,
  queueMessage,
  type QueueMessageInput,
} from './queue-message.js';
import { preflightExistingPromptModel } from './model-preflight.js';
import type {
  CustomerBillingFailure,
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
} from '../execution/types.js';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';

vi.mock('./model-preflight.js', () => ({ preflightExistingPromptModel: vi.fn() }));

type QueueMessageEnv = Pick<Env, 'CLOUD_AGENT_SESSION' | 'SANDBOX_SESSION'>;

function makeDoStub(result: SessionMessageAdmissionResult) {
  const admitSubmittedMessage = vi.fn().mockResolvedValue(result);
  const hasMessageAdmission = vi.fn().mockResolvedValue(false);
  return {
    stub: { admitSubmittedMessage, hasMessageAdmission },
    admitSubmittedMessage,
    hasMessageAdmission,
  };
}

function makeEnv(stub: unknown): QueueMessageEnv {
  return {
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      get: vi.fn(() => stub),
    } as unknown as Env['CLOUD_AGENT_SESSION'],
    SANDBOX_SESSION: {
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      get: vi.fn(() => stub),
    } as unknown as Env['SANDBOX_SESSION'],
  };
}

beforeEach(() => {
  vi.mocked(preflightExistingPromptModel).mockReset().mockResolvedValue(undefined);
});

describe('preflightAndQueuePromptMessage', () => {
  it('retains legacy routing and preflight for a control-plane opted-in user', async () => {
    const { stub, admitSubmittedMessage, hasMessageAdmission } = makeDoStub({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      compatibilityDelivery: 'queued',
    });
    const env = { ...makeEnv(stub), CONTROL_PLANE_IDS: 'user_abc' } as Env;
    const idFromName = vi.spyOn(env.CLOUD_AGENT_SESSION, 'idFromName');
    const getSandboxSession = vi.spyOn(env.SANDBOX_SESSION, 'get');
    const input: QueueMessageInput = {
      cloudAgentSessionId: 'agent_existing',
      turn: { type: 'prompt', id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn', prompt: 'follow up' },
      agent: { model: 'kilo/anthropic/claude-sonnet-4' },
    };

    await expect(
      preflightAndQueuePromptMessage(input, { env, userId: 'user_abc' }, 'send')
    ).resolves.toMatchObject({ delivery: 'queued', messageId: input.turn.id });

    expect(hasMessageAdmission).toHaveBeenCalledExactlyOnceWith(input.turn.id);
    expect(preflightExistingPromptModel).toHaveBeenCalledExactlyOnceWith({
      env,
      userId: 'user_abc',
      cloudAgentSessionId: 'agent_existing',
      requestedModel: 'kilo/anthropic/claude-sonnet-4',
      procedure: 'send',
    });
    expect(vi.mocked(preflightExistingPromptModel).mock.invocationCallOrder[0]).toBeLessThan(
      admitSubmittedMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(idFromName).toHaveBeenCalledWith('user_abc:agent_existing');
    expect(getSandboxSession).not.toHaveBeenCalled();
  });
});

describe('queueMessage', () => {
  it('returns the DO result mapped to an ExecutionResponse on success', async () => {
    const { stub, admitSubmittedMessage } = makeDoStub({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });

    const response = await queueMessage(
      {
        cloudAgentSessionId: 'agent_1234' as SessionId,
        turn: { type: 'prompt', prompt: 'hello' },
      },
      {
        env: makeEnv(stub) as Env,
        userId: 'user_abc',
      }
    );

    expect(response.cloudAgentSessionId).toBe('agent_1234');
    expect(response.status).toBe('started');
    expect(response.delivery).toBe('queued');
    expect(response.streamUrl).toBe('/stream?cloudAgentSessionId=agent_1234');
    expect(admitSubmittedMessage).toHaveBeenCalledTimes(1);
    const request = admitSubmittedMessage.mock.calls[0]?.[0] as
      | SubmittedSessionMessageRequest
      | undefined;
    expect(request).toMatchObject({
      userId: 'user_abc',
      turn: { type: 'prompt', prompt: 'hello' },
    });
    expect(request?.turn.id).toBeUndefined();
  });

  it('projects an already runtime-accepted replay as sent at the public seam', async () => {
    const { stub } = makeDoStub({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'sent',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });

    const response = await queueMessage(
      {
        cloudAgentSessionId: 'agent_y' as SessionId,
        turn: { type: 'prompt', id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn', prompt: 'hello' },
      },
      { env: makeEnv(stub) as Env, userId: 'user_a' }
    );

    expect(response).toMatchObject({ status: 'started', delivery: 'sent' });
  });

  it('forwards the caller messageId when provided', async () => {
    const { stub, admitSubmittedMessage } = makeDoStub({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });

    await queueMessage(
      {
        cloudAgentSessionId: 'agent_y' as SessionId,
        turn: { type: 'prompt', id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn', prompt: 'hello' },
      },
      { env: makeEnv(stub) as Env, userId: 'user_a' }
    );

    const request = admitSubmittedMessage.mock.calls[0]?.[0] as
      | SubmittedSessionMessageRequest
      | undefined;
    expect(request?.turn.id).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
  });

  it('forwards canonical document attachments to the Durable Object', async () => {
    const { stub, admitSubmittedMessage } = makeDoStub({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });

    await queueMessage(
      {
        cloudAgentSessionId: 'agent_document' as SessionId,
        turn: {
          type: 'prompt',
          prompt: 'inspect the PDF',
          attachments: {
            path: '123e4567-e89b-12d3-a456-426614174000',
            files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
          },
        },
      },
      { env: makeEnv(stub) as Env, userId: 'user_document' }
    );

    expect(admitSubmittedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({
          attachments: {
            path: '123e4567-e89b-12d3-a456-426614174000',
            files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
          },
        }),
      })
    );
  });

  it('forwards the composed canonical message payload to the Durable Object', async () => {
    const { stub, admitSubmittedMessage } = makeDoStub({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });

    await queueMessage(
      {
        cloudAgentSessionId: 'agent_payload' as SessionId,
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
      { env: makeEnv(stub) as Env, userId: 'user_payload', botId: 'bot_payload' }
    );

    expect(admitSubmittedMessage).toHaveBeenCalledWith({
      userId: 'user_payload',
      botId: 'bot_payload',
      turn: {
        type: 'prompt',
        id: undefined,
        prompt: 'inspect the screenshot',
        attachments: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.png'],
        },
      },
      agent: { mode: 'plan', model: 'queued-model', variant: 'thinking' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });
  });

  it('maps NOT_FOUND to 404 TRPCError', async () => {
    const { stub } = makeDoStub({ success: false, code: 'NOT_FOUND', error: 'gone' });
    await expect(
      queueMessage(
        {
          cloudAgentSessionId: 'agent_x' as SessionId,
          turn: { type: 'prompt', prompt: 'x' },
        },
        { env: makeEnv(stub) as Env, userId: 'u' }
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'gone' });
  });

  it('maps BAD_REQUEST to 400 TRPCError', async () => {
    const { stub } = makeDoStub({ success: false, code: 'BAD_REQUEST', error: 'nope' });
    await expect(
      queueMessage(
        {
          cloudAgentSessionId: 'agent_x' as SessionId,
          turn: { type: 'prompt', prompt: 'x' },
        },
        { env: makeEnv(stub) as Env, userId: 'u' }
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'nope' });
  });

  it.each([
    ['FORBIDDEN', 'FORBIDDEN', false, 'msg_018f1e2d3c4bAbCdEfGhIjKlMn'],
    ['MODEL_VALIDATION_UNAVAILABLE', 'SERVICE_UNAVAILABLE', true, undefined],
  ] as const)(
    'preserves returned control %s as %s with retryable %s',
    async (resultCode, trpcCode, retryable, messageId) => {
      const message = 'Model validation rejected the prompt';
      const { stub, admitSubmittedMessage, hasMessageAdmission } = makeDoStub({
        success: false,
        code: resultCode,
        error: message,
      });
      const env = makeEnv(stub);
      const idFromName = vi.spyOn(env.SANDBOX_SESSION, 'idFromName');
      const getLegacySession = vi.spyOn(env.CLOUD_AGENT_SESSION, 'get');
      const error: unknown = await preflightAndQueuePromptMessage(
        {
          cloudAgentSessionId: 'workspace_existing',
          turn: { type: 'prompt', id: messageId, prompt: 'follow up' },
        },
        { env: env as Env, userId: 'user_abc' },
        'send'
      ).catch(error => error);

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({
        code: trpcCode,
        message,
        cause: { error: resultCode, message, retryable },
      });
      expect(admitSubmittedMessage).toHaveBeenCalledOnce();
      expect(idFromName).toHaveBeenCalledWith('user_abc:workspace_existing');
      expect(getLegacySession).not.toHaveBeenCalled();
      expect(hasMessageAdmission).not.toHaveBeenCalled();
      expect(preflightExistingPromptModel).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['PAYMENT_REQUIRED', 'PAYMENT_REQUIRED', 'INSUFFICIENT_CREDITS', false],
    ['COMPUTE_STOPPING', 'CONFLICT', 'COMPUTE_STOPPING', true],
    ['BILLING_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'BILLING_UNAVAILABLE', true],
  ] as const)(
    'preserves %s billing failure details and retryability',
    async (resultCode, trpcCode, billingCode, retryable) => {
      const billingFailure: CustomerBillingFailure = {
        code: billingCode,
        payer: { type: 'org', id: 'org_abc' },
        retryable,
        remainingMicrodollars: 1,
        minimumRequiredMicrodollars: 5,
      };
      const { stub } = makeDoStub({
        success: false,
        code: resultCode,
        error: 'Compute billing rejected admission',
        billingFailure,
        failureBoundary: 'admission',
      });

      await expect(
        queueMessage(
          { cloudAgentSessionId: 'agent_existing', turn: { type: 'prompt', prompt: 'follow up' } },
          { env: makeEnv(stub) as Env, userId: 'user_abc' }
        )
      ).rejects.toMatchObject({
        code: trpcCode,
        cause: { error: resultCode, retryable, billingFailure },
      });
    }
  );

  it('maps PENDING_QUEUE_FULL to a retryable TOO_MANY_REQUESTS error', async () => {
    const { stub } = makeDoStub({ success: false, code: 'PENDING_QUEUE_FULL', error: 'full' });
    const error = await queueMessage(
      {
        cloudAgentSessionId: 'agent_x' as SessionId,
        turn: { type: 'prompt', prompt: 'x' },
      },
      { env: makeEnv(stub) as Env, userId: 'u' }
    ).catch(error => error);

    expect(error).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'full',
      cause: { error: 'PENDING_QUEUE_FULL', retryable: true },
    });
  });

  it('maps INTERNAL to an explicitly retryable 500 error', async () => {
    const { stub } = makeDoStub({ success: false, code: 'INTERNAL', error: 'boom' });
    const error = await queueMessage(
      {
        cloudAgentSessionId: 'agent_x' as SessionId,
        turn: { type: 'prompt', prompt: 'x' },
      },
      { env: makeEnv(stub) as Env, userId: 'u' }
    ).catch(error => error);

    expect(error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'boom',
      cause: { error: 'INTERNAL', retryable: true },
    });
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['BAD_REQUEST', 'BAD_REQUEST'],
  ] as const)('marks permanent %s admission errors non-retryable', async (resultCode, trpcCode) => {
    const { stub } = makeDoStub({ success: false, code: resultCode, error: 'permanent' });
    const error = await queueMessage(
      {
        cloudAgentSessionId: 'agent_x' as SessionId,
        turn: { type: 'prompt', prompt: 'x' },
      },
      { env: makeEnv(stub) as Env, userId: 'u' }
    ).catch(error => error);

    expect(error).toMatchObject({
      code: trpcCode,
      cause: { error: resultCode, retryable: false },
    });
  });

  it('maps retryable SANDBOX_CONNECT_FAILED to SERVICE_UNAVAILABLE with retryable cause', async () => {
    const { stub } = makeDoStub({
      success: false,
      code: 'SANDBOX_CONNECT_FAILED',
      error: 'transient',
    });
    await expect(
      queueMessage(
        {
          cloudAgentSessionId: 'agent_x' as SessionId,
          turn: { type: 'prompt', prompt: 'x' },
        },
        { env: makeEnv(stub) as Env, userId: 'u' }
      )
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'transient' });

    try {
      await queueMessage(
        {
          cloudAgentSessionId: 'agent_x' as SessionId,
          turn: { type: 'prompt', prompt: 'x' },
        },
        { env: makeEnv(stub) as Env, userId: 'u' }
      );
    } catch (err) {
      if (err instanceof TRPCError) {
        expect(err.cause).toMatchObject({
          error: 'SANDBOX_CONNECT_FAILED',
          retryable: true,
        });
      } else {
        throw err;
      }
    }
  });
});
