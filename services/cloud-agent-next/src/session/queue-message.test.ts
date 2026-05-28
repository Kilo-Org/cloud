import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { queueMessage } from './queue-message.js';
import type {
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
} from '../execution/types.js';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';

type QueueMessageEnv = Pick<Env, 'CLOUD_AGENT_SESSION'>;

function makeDoStub(result: SessionMessageAdmissionResult): {
  stub: unknown;
  admitSubmittedMessage: ReturnType<typeof vi.fn>;
} {
  const admitSubmittedMessage = vi.fn().mockResolvedValue(result);
  return {
    stub: { admitSubmittedMessage },
    admitSubmittedMessage,
  };
}

function makeEnv(stub: unknown): QueueMessageEnv {
  return {
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      get: vi.fn(() => stub),
    } as unknown as Env['CLOUD_AGENT_SESSION'],
  };
}

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

  it('maps PENDING_QUEUE_FULL to TOO_MANY_REQUESTS', async () => {
    const { stub } = makeDoStub({ success: false, code: 'PENDING_QUEUE_FULL', error: 'full' });
    await expect(
      queueMessage(
        {
          cloudAgentSessionId: 'agent_x' as SessionId,
          turn: { type: 'prompt', prompt: 'x' },
        },
        { env: makeEnv(stub) as Env, userId: 'u' }
      )
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'full' });
  });

  it('maps INTERNAL to 500', async () => {
    const { stub } = makeDoStub({ success: false, code: 'INTERNAL', error: 'boom' });
    await expect(
      queueMessage(
        {
          cloudAgentSessionId: 'agent_x' as SessionId,
          turn: { type: 'prompt', prompt: 'x' },
        },
        { env: makeEnv(stub) as Env, userId: 'u' }
      )
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' });
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
