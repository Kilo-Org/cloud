import { describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_CONTROL_OUTCOME_TIMEOUT_MS,
  sessionOperationExpiresAt,
  sessionOperationResultHash,
  type ResponseFrame,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type { EventQueries } from '../session/queries/index.js';
import type { StoredEvent } from '../websocket/types.js';
import { logger } from '../logger.js';
import {
  applySessionOperationResult,
  createSessionMessageRecord,
  recordSessionOperationDispatch,
  type SessionMessageRecord,
} from './session-message-queue.js';
import {
  commitSessionOperationResult,
  dispatchSessionOperation,
  reconcileSessionOperation,
  type SessionOperationEffects,
} from './session-operation.js';

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

  it('resolves a running attach through the production deadline closure without persisting', async () => {
    const attachAuthorization: SessionOperationAuthorization = {
      operation: 'session.attach',
      operationId: 'attempt_attach_1',
      messageId: authorization.messageId,
      session: authorization.session,
      wrapperInstanceId: authorization.wrapperInstanceId,
      dispatchDeadlineAt: Date.now() + 60_000,
    };
    const dispatched = recordSessionOperationDispatch(messages(), attachAuthorization);
    if (!dispatched) throw new Error('Failed to create attach dispatch proof');
    let stored = dispatched;
    const commit = vi.fn((next: SessionMessageRecord[]) => {
      stored = next;
      return true;
    });
    const request = vi.fn(async (_input: SandboxControlOutboundRequest) =>
      response({
        state: 'running',
        authorization: attachAuthorization,
        executionDeadlineAt: Date.now() + 60_000,
      })
    );

    await expect(
      dispatchSessionOperation(
        { authorization: attachAuthorization, payload: {} },
        { read: () => stored, commit },
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
    expect(commit).not.toHaveBeenCalled();
    expect(stored).toEqual(dispatched);
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

  it('retires a dispatched attach the runtime has no record of and dispatches a fresh attach', async () => {
    const attach: SessionOperationAuthorization = {
      operation: 'session.attach',
      operationId: 'attempt-attach',
      messageId: 'msg_attach',
      session: {
        sessionId: 'workspace_attach',
        kiloSessionId: 'kilo_attach',
        directory: '/workspace/attach',
      },
      wrapperInstanceId: '22222222-2222-4222-8222-222222222222',
      dispatchDeadlineAt: Date.now() + 60_000,
    };
    const attachResult = {
      attached: true as const,
      nativeRuntimeId: '33333333-3333-4333-8333-333333333333',
    };
    const seeded = recordSessionOperationDispatch(
      [
        {
          ...messages()[0]!,
          messageId: attach.messageId,
          wrapperInstanceId: attach.wrapperInstanceId,
        },
      ],
      attach
    );
    if (!seeded) throw new Error('Failed to create attach dispatch proof');
    let stored = seeded;
    const request = vi.fn(async (input: SandboxControlOutboundRequest) => {
      if (input.operation === 'session.operation.get') return response({ state: 'missing' });
      if (input.operation === 'session.attach') return response(attachResult);
      throw new Error(`Unexpected operation ${input.operation}`);
    });

    await expect(
      dispatchSessionOperation(
        { authorization: attach, payload: {} },
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
    ).resolves.toEqual({ state: 'response', result: attachResult });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      'session.operation.get',
      'session.attach',
    ]);
    expect(stored[0]?.operations?.attach?.dispatched).toBe(true);
    expect(stored[0]?.operations?.retiredAttach).toMatchObject({ authorization: attach });
  });

  it('keeps a dispatched prompt when the runtime has no record of it', async () => {
    const dispatched = recordSessionOperationDispatch(messages(), authorization);
    if (!dispatched) throw new Error('Failed to create dispatch proof');
    let stored = dispatched;
    const request = vi.fn(async (input: SandboxControlOutboundRequest) => {
      if (input.operation === 'session.operation.get') return response({ state: 'missing' });
      throw new Error(`Unexpected operation ${input.operation}`);
    });

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
    ).resolves.toEqual({ state: 'uncertain', reason: 'missing' });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(['session.operation.get']);
    expect(stored[0]?.operations?.prompt?.dispatched).toBe(true);
    expect(stored[0]?.operations?.retiredAttach).toBeUndefined();
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

  it('invokes message commit inside the only result transaction', async () => {
    const dispatched = recordSessionOperationDispatch(messages(), authorization);
    if (!dispatched) throw new Error('Failed to create dispatch proof');
    let stored = dispatched;
    let depth = 0;
    let commitDepth: number | undefined;
    const storage = {
      transactionSync: <T>(callback: () => T): T => {
        depth += 1;
        try {
          return callback();
        } finally {
          depth -= 1;
        }
      },
    };
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization,
      completedAt: Date.now(),
      result: { ok: true, result: { messageId: authorization.messageId, status: 'accepted' } },
      outcome: { messageId: authorization.messageId, status: 'completed' },
      events: [],
      preparing: [],
    };
    const hash = await sessionOperationResultHash(delivery);
    const acknowledgement = commitSessionOperationResult({
      storage,
      delivery,
      hash,
      deadlineAt: Date.now() + 1_000,
      isCurrent: () => true,
      messages: {
        read: () => stored,
        commit: next => {
          commitDepth = depth;
          stored = next;
          return true;
        },
      },
      notifications: [],
    });
    expect(acknowledgement).toMatchObject({ disposition: 'applied', resultHash: hash });
    expect(commitDepth).toBe(1);
  });
});

describe('reconcileSessionOperation unconfirmed diagnostics', () => {
  function effects(
    request: SessionOperationEffects['request'],
    overrides: Partial<SessionOperationEffects> = {}
  ): SessionOperationEffects {
    return {
      request,
      persistResult: async () => undefined,
      assertAdmission: () => undefined,
      assertScope: () => undefined,
      defer: pending => void pending,
      ...overrides,
    };
  }

  async function capture<T>(
    run: () => Promise<T>
  ): Promise<{ result: T; events: Record<string, unknown>[] }> {
    const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const result = await run();
      const events = withFields.mock.calls
        .map(call => call[0] as Record<string, unknown>)
        .filter(fields => fields.diagnosticEvent === 'session_operation_reconcile');
      return { result, events };
    } finally {
      withFields.mockRestore();
    }
  }

  it('reports a missing lookup and still resolves uncertain/missing', async () => {
    const request = vi.fn(async () => response({ state: 'missing' }));

    const { result, events } = await capture(() =>
      reconcileSessionOperation(
        authorization,
        sessionOperationExpiresAt(authorization),
        effects(request)
      )
    );

    expect(result).toEqual({ state: 'uncertain', reason: 'missing' });
    expect(events).toEqual([
      expect.objectContaining({
        diagnosticEvent: 'session_operation_reconcile',
        sessionId: authorization.session.sessionId,
        messageId: authorization.messageId,
        operation: 'session.prompt',
        operationId: authorization.operationId,
        reason: 'missing',
        lookupState: 'missing',
      }),
    ]);
  });

  it('reports an unpersistable running deadline and resolves uncertain/unverified', async () => {
    const request = vi.fn(async () =>
      response({ state: 'running', authorization, executionDeadlineAt: Date.now() + 30_000 })
    );

    const { result, events } = await capture(() =>
      reconcileSessionOperation(
        authorization,
        sessionOperationExpiresAt(authorization),
        effects(request, { recordExecutionDeadline: () => false })
      )
    );

    expect(result).toEqual({ state: 'uncertain', reason: 'unverified' });
    expect(events).toEqual([
      expect.objectContaining({ reason: 'unverified', lookupState: 'running' }),
    ]);
  });

  it('reports an unpersistable completed delivery and resolves uncertain/unverified', async () => {
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization,
      completedAt: Date.now(),
      result: { ok: true, result: { messageId: authorization.messageId, status: 'accepted' } },
      outcome: { messageId: authorization.messageId, status: 'completed' },
      events: [],
      preparing: [],
    };
    const request = vi.fn(async () => response({ state: 'completed', delivery }));

    const { result, events } = await capture(() =>
      reconcileSessionOperation(
        authorization,
        sessionOperationExpiresAt(authorization),
        effects(request)
      )
    );

    expect(result).toEqual({ state: 'uncertain', reason: 'unverified' });
    expect(events).toEqual([
      expect.objectContaining({ reason: 'unverified', lookupState: 'completed' }),
    ]);
  });

  it('emits no diagnostic for a clean running reconcile', async () => {
    const request = vi.fn(async () => response({ state: 'running', authorization }));

    const { result, events } = await capture(() =>
      reconcileSessionOperation(
        authorization,
        sessionOperationExpiresAt(authorization),
        effects(request)
      )
    );

    expect(result).toMatchObject({ state: 'running' });
    expect(events).toEqual([]);
  });
});
