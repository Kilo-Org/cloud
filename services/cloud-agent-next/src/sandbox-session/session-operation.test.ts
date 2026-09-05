import { describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  sessionOperationResultHash,
  type ResponseFrame,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { EventQueries } from '../session/queries/index.js';
import type { StoredEvent } from '../websocket/types.js';
import {
  applySessionOperationResult,
  createSessionMessageRecord,
  recordSessionOperationDispatch,
  type SessionMessageRecord,
} from './session-message-queue.js';
import { commitSessionOperationResult, dispatchSessionOperation } from './session-operation.js';

const authorization: SessionOperationAuthorization = {
  operation: 'session.prompt',
  operationId: 'msg_operation_1',
  messageId: 'msg_operation_1',
  session: {
    sessionId: 'workspace_operation_1',
    kiloSessionId: 'kilo_operation_1',
    directory: '/workspace/operation',
  },
  wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
  dispatchDeadlineAt: Date.now() + 60_000,
};

const payload = {
  messageId: authorization.messageId,
  turn: { type: 'prompt' as const, prompt: 'durably deliver this prompt' },
  agent: { mode: 'code' as const, model: 'kilo/openai/gpt-4.1' },
};

function response(result: unknown): ResponseFrame {
  return { type: 'response', requestId: crypto.randomUUID(), ok: true, result };
}

function messages(): SessionMessageRecord[] {
  return [
    {
      ...createSessionMessageRecord({
        turn: { type: 'prompt', messageId: authorization.messageId, prompt: payload.turn.prompt },
        agent: payload.agent,
      }),
      wrapperInstanceId: authorization.wrapperInstanceId,
    },
  ];
}

describe('dispatchSessionOperation', () => {
  it('writes the immutable prompt proof before the first wrapper request', async () => {
    let stored = messages();
    const request = vi.fn(async (input: SandboxControlOutboundRequest) => {
      expect(input).toMatchObject({ operation: 'session.prompt', authorization, payload });
      expect(stored).toMatchObject([
        {
          unresolvedDispatch: true,
          operations: { prompt: { dispatched: true, authorization } },
        },
      ]);
      return response({ messageId: authorization.messageId, status: 'accepted' });
    });

    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        {
          read: () => stored,
          commit: next => {
            stored = next;
            return true;
          },
        },
        {
          request,
          persistResult: async () => undefined,
          assertAdmission: () => undefined,
          assertScope: () => undefined,
          defer: pending => void pending,
          isCurrent: () => true,
        }
      )
    ).resolves.toEqual({
      state: 'response',
      result: { messageId: authorization.messageId, status: 'accepted' },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the retained result and exact acknowledgement after a lost prompt response', async () => {
    const lateAuthorization = { ...authorization, dispatchDeadlineAt: Date.now() - 1_000 };
    const dispatched = recordSessionOperationDispatch(messages(), lateAuthorization);
    if (!dispatched) throw new Error('Failed to create dispatch proof');
    let stored = dispatched;
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization: lateAuthorization,
      completedAt: Date.now(),
      result: { ok: true, result: { messageId: lateAuthorization.messageId, status: 'accepted' } },
      outcome: { messageId: lateAuthorization.messageId, status: 'completed' },
      events: [],
      preparing: [],
    };
    const ack = {
      version: 2 as const,
      authorization: lateAuthorization,
      resultHash: await sessionOperationResultHash(delivery),
      disposition: 'applied' as const,
      decision: { state: 'completed' as const, at: delivery.completedAt },
    };
    const request = vi.fn(async (input: SandboxControlOutboundRequest) => {
      if (input.operation === 'session.operation.get') {
        expect(input.deadlineAt).toBeGreaterThan(Date.now());
        return response({ state: 'completed', delivery });
      }
      expect(input).toMatchObject({ operation: 'session.operation.ack', payload: ack });
      expect(input.deadlineAt).toBe(delivery.completedAt + SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS);
      return response({ acknowledged: true });
    });

    await expect(
      dispatchSessionOperation(
        { authorization: lateAuthorization, payload },
        {
          read: () => stored,
          commit: next => {
            stored = next;
            return true;
          },
        },
        {
          request,
          persistResult: async () => ack,
          assertAdmission: () => undefined,
          assertScope: () => undefined,
          defer: pending => void pending,
          isCurrent: () => false,
        }
      )
    ).resolves.toMatchObject({ state: 'completed' });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      'session.operation.get',
      'session.operation.ack',
    ]);
  });

  it('keeps a positively running operation without replaying its prompt', async () => {
    const dispatched = recordSessionOperationDispatch(messages(), authorization);
    if (!dispatched) throw new Error('Failed to create dispatch proof');
    const request = vi.fn(async (_input: SandboxControlOutboundRequest) =>
      response({
        state: 'running',
        authorization,
      })
    );

    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        { read: () => dispatched, commit: () => true },
        {
          request,
          persistResult: async () => undefined,
          assertAdmission: () => undefined,
          assertScope: () => undefined,
          defer: pending => void pending,
          isCurrent: () => false,
        }
      )
    ).resolves.toMatchObject({ state: 'running' });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(['session.operation.get']);
  });

  it('does not replay a mutation when the retained operation is missing', async () => {
    const dispatched = recordSessionOperationDispatch(messages(), authorization);
    if (!dispatched) throw new Error('Failed to create dispatch proof');
    const request = vi.fn(async (_input: SandboxControlOutboundRequest) =>
      response({ state: 'missing' })
    );

    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        { read: () => dispatched, commit: () => true },
        {
          request,
          persistResult: async () => undefined,
          assertAdmission: () => undefined,
          assertScope: () => undefined,
          defer: pending => void pending,
          isCurrent: () => true,
        }
      )
    ).resolves.toEqual({ state: 'uncertain', reason: 'missing' });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(['session.operation.get']);
  });

  it('does not replay a prompt after its admission response is lost before application', async () => {
    let stored = messages();
    const request = vi.fn(async (input: SandboxControlOutboundRequest) => {
      if (input.operation === 'session.prompt')
        throw Object.assign(new Error('Prompt admission response was lost'), { retryable: true });
      if (input.operation === 'session.operation.get') return response({ state: 'missing' });
      throw new Error(`Unexpected operation ${input.operation}`);
    });
    const effects = {
      request,
      persistResult: async () => undefined,
      assertAdmission: () => undefined,
      assertScope: () => undefined,
      defer: (pending: Promise<void>) => void pending,
      isCurrent: () => true,
    };

    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        { read: () => stored, commit: next => ((stored = next), true) },
        effects
      )
    ).resolves.toEqual({ state: 'uncertain', reason: 'transport', error: expect.any(Error) });
    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        { read: () => stored, commit: next => ((stored = next), true) },
        effects
      )
    ).resolves.toEqual({ state: 'uncertain', reason: 'missing' });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      'session.prompt',
      'session.operation.get',
    ]);
  });

  it('keeps dispatch proof after an unmarked busy rejection', async () => {
    let stored = messages();
    const request = vi.fn(
      async (): Promise<ResponseFrame> => ({
        type: 'response',
        requestId: crypto.randomUUID(),
        ok: false,
        error: { code: 'session_busy', message: 'busy after admission', retryable: true },
      })
    );

    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        { read: () => stored, commit: next => ((stored = next), true) },
        {
          request,
          persistResult: async () => undefined,
          assertAdmission: () => undefined,
          assertScope: () => undefined,
          defer: pending => void pending,
          isCurrent: () => true,
        }
      )
    ).resolves.toMatchObject({ state: 'rejected', error: { code: 'session_busy' } });
    expect(stored[0]?.operations?.prompt?.dispatched).toBe(true);
  });

  it('clears dispatch proof only after an explicit before-admission rejection', async () => {
    let stored = messages();
    const request = vi.fn(
      async (): Promise<ResponseFrame> => ({
        type: 'response',
        requestId: crypto.randomUUID(),
        ok: false,
        error: {
          code: 'session_busy',
          message: 'receipt capacity is unavailable',
          retryable: true,
          admission: 'not-admitted',
        },
      })
    );

    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        { read: () => stored, commit: next => ((stored = next), true) },
        {
          request,
          persistResult: async () => undefined,
          assertAdmission: () => undefined,
          assertScope: () => undefined,
          defer: pending => void pending,
          isCurrent: () => true,
        }
      )
    ).resolves.toMatchObject({ state: 'rejected', error: { code: 'session_busy' } });
    expect(stored[0]).toMatchObject({
      unresolvedDispatch: undefined,
      operations: { prompt: { authorization, dispatched: false } },
    });
  });

  it('persists a recovered result before its acknowledgement can be retried', async () => {
    const dispatched = recordSessionOperationDispatch(messages(), authorization);
    if (!dispatched) throw new Error('Failed to create dispatch proof');
    let stored = dispatched;
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization,
      completedAt: Date.now(),
      result: { ok: true, result: { messageId: authorization.messageId, status: 'accepted' } },
      outcome: { messageId: authorization.messageId, status: 'completed' },
      events: [],
      preparing: [],
    };
    const ack = {
      version: 2 as const,
      authorization,
      resultHash: await sessionOperationResultHash(delivery),
      disposition: 'applied' as const,
      decision: { state: 'completed' as const, at: delivery.completedAt },
    };
    const request = vi.fn(async (input: SandboxControlOutboundRequest) => {
      if (input.operation === 'session.operation.get')
        return response({ state: 'completed', delivery });
      if (input.operation === 'session.operation.ack')
        throw Object.assign(new Error('Acknowledgement response was lost'), { retryable: true });
      throw new Error(`Unexpected operation ${input.operation}`);
    });

    await expect(
      dispatchSessionOperation(
        { authorization, payload },
        { read: () => stored, commit: next => ((stored = next), true) },
        {
          request,
          persistResult: async receipt => {
            const applied = applySessionOperationResult(
              stored,
              receipt,
              await sessionOperationResultHash(receipt),
              Date.now()
            );
            if (!applied) return undefined;
            stored = applied.messages;
            return ack;
          },
          assertAdmission: () => undefined,
          assertScope: () => undefined,
          defer: pending => void pending,
          isCurrent: () => true,
        }
      )
    ).resolves.toMatchObject({ state: 'completed' });
    await Promise.resolve();
    expect(stored).toMatchObject([{ state: 'completed', terminalSource: 'operation_result' }]);
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      'session.operation.get',
      'session.operation.ack',
    ]);
  });

  it('keeps the first canonical result through duplicates and conflicts', async () => {
    const dispatched = recordSessionOperationDispatch(messages(), authorization);
    if (!dispatched) throw new Error('Failed to create dispatch proof');
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization,
      completedAt: Date.now(),
      result: { ok: true, result: { messageId: authorization.messageId, status: 'accepted' } },
      outcome: { messageId: authorization.messageId, status: 'completed' },
      events: [],
      preparing: [],
    };
    const resultHash = await sessionOperationResultHash(delivery);
    const applied = applySessionOperationResult(dispatched, delivery, resultHash, Date.now());
    if (!applied) throw new Error('Failed to apply operation result');
    expect(applied).toMatchObject({
      disposition: 'applied',
      messages: [
        {
          state: 'completed',
          unresolvedDispatch: undefined,
          terminalSource: 'operation_result',
          operations: { prompt: { resultHash } },
        },
      ],
    });

    expect(
      applySessionOperationResult(applied.messages, delivery, resultHash, Date.now())
    ).toMatchObject({
      disposition: 'identical',
    });
    expect(
      applySessionOperationResult(
        applied.messages,
        {
          ...delivery,
          result: {
            ok: false,
            error: { code: 'git_failed', message: 'conflict', retryable: false },
          },
        },
        'f'.repeat(64),
        Date.now()
      )
    ).toMatchObject({ disposition: 'already_final' });
    expect(applied.messages[0]?.operations?.prompt?.resultHash).toBe(resultHash);
  });

  it.each(['event', 'message'] as const)(
    'does not acknowledge or publish a failed %s transaction',
    async failure => {
      const dispatched = recordSessionOperationDispatch(messages(), authorization);
      if (!dispatched) throw new Error('Failed to create dispatch proof');
      let stored = dispatched;
      const delivery: SessionOperationDelivery = {
        version: 2,
        authorization,
        completedAt: Date.now(),
        result: { ok: true, result: { messageId: authorization.messageId, status: 'accepted' } },
        outcome: { messageId: authorization.messageId, status: 'completed' },
        events: [
          {
            type: 'autocommit_completed',
            properties: { success: true, messageId: authorization.messageId },
            timestamp: new Date().toISOString(),
          },
        ],
        preparing: [],
      };
      const hash = await sessionOperationResultHash(delivery);
      const notifications: StoredEvent[] = [];
      const commit = vi.fn((next: SessionMessageRecord[]) => {
        if (failure === 'message') return false;
        stored = next;
        return true;
      });
      const eventQueries = {
        upsert: vi.fn(() => {
          if (failure === 'event') throw new Error('event write failed');
          return 1;
        }),
        insert: vi.fn(() => 1),
      } as unknown as EventQueries;

      expect(() =>
        commitSessionOperationResult({
          storage: { transactionSync: callback => callback() },
          delivery,
          hash,
          deadlineAt: Date.now() + 1_000,
          isCurrent: () => true,
          messages: { read: () => stored, commit },
          eventQueries,
          notifications,
        })
      ).toThrow(failure === 'event' ? 'event write failed' : 'Operation result was not persisted');
      expect(notifications).toEqual([]);
      expect(stored).toEqual(dispatched);

      const acknowledgement = commitSessionOperationResult({
        storage: { transactionSync: callback => callback() },
        delivery,
        hash,
        deadlineAt: Date.now() + 1_000,
        isCurrent: () => true,
        messages: {
          read: () => stored,
          commit: next => {
            stored = next;
            return true;
          },
        },
        eventQueries: { upsert: () => 1, insert: () => 1 } as unknown as EventQueries,
        notifications,
      });
      expect(acknowledgement).toMatchObject({ disposition: 'applied', resultHash: hash });
      expect(stored[0]?.operations?.prompt?.resultHash).toBe(hash);
      expect(notifications).toHaveLength(1);
    }
  );
});
