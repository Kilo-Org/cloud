import { describe, expect, it } from 'vitest';
import { decideSession } from './reduce.js';
import { POLICY } from '../schedule.js';
import type {
  RuntimeHandle,
  SessionAggregate,
  SessionMessage,
  SessionMessageIntent,
} from '../model/session.js';

const NOW = 3_000_000;
const HANDLE: RuntimeHandle = { incarnation: 'inc-1', wrapper: 'w', epoch: 1 };
const OTHER_HANDLE: RuntimeHandle = { incarnation: 'inc-2', wrapper: 'w2', epoch: 2 };

function intent(messageId = 'm1'): SessionMessageIntent {
  return { turn: { type: 'prompt', messageId, prompt: 'hi' }, agent: { mode: 'code', model: 'm' } };
}

function aggregate(
  messages: SessionMessage[],
  binding: SessionAggregate['binding'] = { kind: 'unbound' }
): SessionAggregate {
  return { binding, messages };
}

function bound(messages: SessionMessage[] = []): SessionAggregate {
  return aggregate(messages, { kind: 'bound', handle: HANDLE });
}

function queued(id = 'm1', deadlineAt: number | null = null): SessionMessage {
  return {
    messageId: id,
    state: {
      kind: 'queued',
      intent: intent(id),
      deliveryStep: 'waiting',
      deadlineAt,
      attachFailures: 0,
      promptFailures: 0,
    },
  };
}

function accepted(id = 'm1', executionDeadlineAt: number = NOW + 60_000): SessionMessage {
  return {
    messageId: id,
    state: {
      kind: 'accepted',
      intent: intent(id),
      acceptedAt: NOW - 1_000,
      wrapperInstanceId: 'w',
      executionDeadlineAt,
    },
  };
}

function firstMessage(result: ReturnType<typeof decideSession>): SessionMessage | undefined {
  return result?.state.messages[0];
}

function stopProof(overrides: Partial<{ incarnation: string; wrapper: string }> = {}) {
  return {
    effect: 'destroy' as const,
    at: NOW,
    providerRef: 'ref',
    incarnation: 'inc-1',
    wrapper: 'w',
    reason: 'unresponsive',
    ...overrides,
  };
}

describe('session reducer — design §7 transitions', () => {
  it('unbound + BIND → bound', () => {
    const decision = decideSession(aggregate([]), { type: 'BIND', handle: HANDLE }, NOW);
    expect(decision?.state.binding.kind).toBe('bound');
  });

  it('bound + BIND with a different handle is rejected', () => {
    expect(decideSession(bound(), { type: 'BIND', handle: OTHER_HANDLE }, NOW)).toBeUndefined();
  });

  it('bound + UNBIND → unbound', () => {
    const decision = decideSession(bound(), { type: 'UNBIND' }, NOW);
    expect(decision?.state.binding.kind).toBe('unbound');
  });

  it('UNBIND is rejected while accepted work remains', () => {
    expect(decideSession(bound([accepted()]), { type: 'UNBIND' }, NOW)).toBeUndefined();
    // A mixed aggregate whose head is queued must not slip through either.
    expect(
      decideSession(bound([queued('m1'), accepted('m2')]), { type: 'UNBIND' }, NOW)
    ).toBeUndefined();
  });

  it('unresolved + BIND resolves to the authoritative handle', () => {
    const state: SessionAggregate = { binding: { kind: 'unresolved' }, messages: [accepted()] };
    const decision = decideSession(state, { type: 'BIND', handle: HANDLE }, NOW);
    expect(decision?.state.binding).toEqual({ kind: 'bound', handle: HANDLE });
  });

  it('unresolved + UNBIND → unbound without accepted work', () => {
    const decision = decideSession(
      { binding: { kind: 'unresolved' }, messages: [] },
      { type: 'UNBIND' },
      NOW
    );
    expect(decision?.state.binding.kind).toBe('unbound');
  });

  it('unbound + DEMAND emits Acquire', () => {
    const decision = decideSession(
      aggregate([]),
      {
        type: 'DEMAND',
        requestId: 'req-1',
        deliveryDeadlineAt: NOW + 5_000,
      },
      NOW
    );
    expect(decision?.commands.map(command => command.kind)).toEqual(['Acquire']);
  });

  it('bound + DEMAND is rejected', () => {
    expect(
      decideSession(bound(), { type: 'DEMAND', requestId: 'req-1', deliveryDeadlineAt: NOW }, NOW)
    ).toBeUndefined();
  });

  it('ENQUEUE adds a queued message and duplicate ids are rejected', () => {
    const decision = decideSession(aggregate([]), { type: 'ENQUEUE', message: queued() }, NOW);
    expect(decision?.state.messages).toHaveLength(1);
    expect(
      decideSession(decision!.state, { type: 'ENQUEUE', message: queued() }, NOW)
    ).toBeUndefined();
  });

  it('ACCEPT requires a bound session and installs the runtime handle', () => {
    expect(
      decideSession(
        aggregate([queued()]),
        { type: 'ACCEPT', messageId: 'm1', acceptedAt: NOW },
        NOW
      )
    ).toBeUndefined();
    const decision = decideSession(
      bound([queued()]),
      { type: 'ACCEPT', messageId: 'm1', acceptedAt: NOW },
      NOW
    );
    const message = firstMessage(decision);
    expect(message?.state.kind).toBe('accepted');
    expect(message?.state.kind === 'accepted' && message.state.wrapperInstanceId).toBe('w');
  });

  it('ACCEPT always installs a bounded execution deadline and a recheck anchor', () => {
    const decision = decideSession(
      bound([queued()]),
      { type: 'ACCEPT', messageId: 'm1', acceptedAt: NOW },
      NOW
    );
    const message = firstMessage(decision);
    expect(message?.state.kind === 'accepted' && message.state.executionDeadlineAt).toBe(
      NOW + POLICY.acceptedExecutionBoundMs
    );
    expect(message?.state.kind === 'accepted' && message.state.capAt).toBe(
      NOW + POLICY.acceptedRecheckMs
    );
    expect(decision?.deadlineAt).toBe(NOW + POLICY.acceptedRecheckMs);

    const supplied = decideSession(
      bound([queued()]),
      { type: 'ACCEPT', messageId: 'm1', acceptedAt: NOW, executionDeadlineAt: NOW + 5_000 },
      NOW
    );
    const suppliedMessage = firstMessage(supplied);
    expect(
      suppliedMessage?.state.kind === 'accepted' && suppliedMessage.state.executionDeadlineAt
    ).toBe(NOW + 5_000);
  });

  it('ACCEPT of a non-head message is rejected', () => {
    expect(
      decideSession(
        bound([queued('m1'), queued('m2')]),
        { type: 'ACCEPT', messageId: 'm2', acceptedAt: NOW },
        NOW
      )
    ).toBeUndefined();
  });

  it('queued + DELIVERY_STEP changes the step but never the deadline', () => {
    const state = bound([queued('m1', NOW + 60_000)]);
    const decision = decideSession(
      state,
      {
        type: 'DELIVERY_STEP',
        messageId: 'm1',
        step: 'preparing',
        preparationAttemptId: 'attempt-1',
        retryNotBefore: NOW + 5_000,
      },
      NOW
    );
    const message = firstMessage(decision);
    expect(message?.state.kind === 'queued' && message.state.deliveryStep).toBe('preparing');
    expect(message?.state.kind === 'queued' && message.state.deadlineAt).toBe(NOW + 60_000);
  });

  it('every decision reports the aggregate deadline', () => {
    const decision = decideSession(
      bound([queued('m1', NOW + 60_000)]),
      { type: 'DELIVERY_STEP', messageId: 'm1', step: 'preparing' },
      NOW
    );
    expect(decision?.deadlineAt).toBe(NOW + 60_000);
  });

  it('queued + CANCEL → cancelled', () => {
    const decision = decideSession(
      bound([queued()]),
      {
        type: 'CANCEL',
        scope: 'message',
        messageId: 'm1',
        at: NOW,
      },
      NOW
    );
    expect(firstMessage(decision)?.state.kind).toBe('cancelled');
  });

  it('queued + CANCEL with a wrapper binding but no dispatch cancels immediately', () => {
    const withWrapper: SessionMessage = {
      ...queued(),
      state: { ...queued().state, wrapperInstanceId: 'w' } as SessionMessage['state'],
    };
    expect(
      decideSession(
        bound([withWrapper]),
        { type: 'CANCEL', scope: 'message', messageId: 'm1', at: NOW },
        NOW
      )?.state.messages[0]?.state.kind
    ).toBe('cancelled');
  });

  it('queued + CANCEL with an ambiguous dispatch records a bounded cancellation and does not claim it stopped', () => {
    const dispatched: SessionMessage = {
      ...queued(),
      proofs: {
        prompt: {
          authorization: {
            operation: 'session.prompt',
            operationId: 'op',
            messageId: 'm1',
            session: { sessionId: 's', kiloSessionId: 'k', directory: '/d' },
            wrapperInstanceId: 'w',
            dispatchDeadlineAt: NOW,
          },
          dispatched: true,
        },
      },
    };
    const decision = decideSession(
      bound([dispatched]),
      {
        type: 'CANCEL',
        scope: 'message',
        messageId: 'm1',
        at: NOW,
      },
      NOW
    )!;
    const message = firstMessage(decision);
    expect(message?.state.kind).toBe('queued');
    expect(message?.cancellation?.operationId).toBe('cancel:m1:' + NOW);
    expect(message?.cancellation?.deadlineAt).toBe(NOW + POLICY.cancellationDeadlineMs);
    // The cancellation deadline is scheduled through the aggregate clock.
    expect(decision.deadlineAt).toBe(NOW + POLICY.cancellationDeadlineMs);
  });

  it('an ambiguous dispatch cancellation settles on the deadline as unconfirmed failure', () => {
    const ambiguous: SessionMessage = {
      ...queued(),
      state: { ...queued().state, unresolvedDispatch: true } as SessionMessage['state'],
    };
    const recorded = decideSession(
      bound([ambiguous]),
      {
        type: 'CANCEL',
        scope: 'message',
        messageId: 'm1',
        at: NOW,
      },
      NOW
    )!.state;
    const settled = decideSession(
      recorded,
      { type: 'DEADLINE' },
      NOW + POLICY.cancellationDeadlineMs
    )!;
    const message = firstMessage(settled);
    expect(message?.state.kind).toBe('failed');
    expect(message?.state.kind === 'failed' && message.state.reason).toBe(
      'cancellation_unconfirmed'
    );
  });

  it('accepted + CANCEL settles the message without replaying work', () => {
    const decision = decideSession(
      bound([accepted()]),
      {
        type: 'CANCEL',
        scope: 'message',
        messageId: 'm1',
        at: NOW,
      },
      NOW
    );
    const message = firstMessage(decision);
    expect(message?.state.kind).toBe('cancelled');
    expect(decision?.commands).toEqual([]);
  });

  it('OUTCOME preserves the immutable intent on a terminal message', () => {
    const decision = decideSession(
      bound([accepted()]),
      {
        type: 'OUTCOME',
        messageId: 'm1',
        status: 'completed',
        at: NOW,
        source: 'wrapper_outcome',
      },
      NOW
    );
    const message = firstMessage(decision);
    expect(message?.state.kind).toBe('completed');
    expect(message?.state.intent?.turn.messageId).toBe('m1');
  });

  it('STOPPED fails in-flight work and preserves queued work for re-drain', () => {
    const queuedRow: SessionMessage = {
      messageId: 'm1',
      state: {
        kind: 'queued',
        intent: intent('m1'),
        deliveryStep: 'waiting',
        deadlineAt: NOW + 30_000,
        attachFailures: 0,
        promptFailures: 0,
        preparationAttemptId: 'prep-1',
      },
    };
    const decision = decideSession(
      bound([queuedRow, accepted('m2')]),
      {
        type: 'STOPPED',
        proof: stopProof(),
        reason: 'health_unhealthy_unresponsive',
      },
      NOW
    );
    expect(decision?.state.binding.kind).toBe('unbound');
    const preserved = firstMessage(decision);
    expect(preserved?.state.kind).toBe('queued');
    expect(preserved?.state.kind === 'queued' && preserved.state.preparationAttemptId).toBe(
      'prep-1'
    );
    expect(preserved?.state.kind === 'queued' && preserved.state.deadlineAt).toBe(NOW + 30_000);
    const failed = decision?.state.messages[1];
    expect(failed?.state.kind === 'failed' && failed.state.reason).toBe(
      'health_unhealthy_unresponsive'
    );
    expect(decision?.deadlineAt).toBe(NOW + 30_000);
  });

  it('STOPPED rejects a stale incarnation or wrapper before mutating messages', () => {
    const state = bound([accepted()]);
    expect(
      decideSession(
        state,
        { type: 'STOPPED', proof: stopProof({ incarnation: 'inc-2' }), reason: 'loss' },
        NOW
      )
    ).toBeUndefined();
    expect(
      decideSession(
        state,
        { type: 'STOPPED', proof: stopProof({ wrapper: 'other' }), reason: 'loss' },
        NOW
      )
    ).toBeUndefined();
  });

  it('STOPPED rejects a duplicate loss after the session is unbound', () => {
    const first = decideSession(
      bound([accepted()]),
      { type: 'STOPPED', proof: stopProof(), reason: 'loss' },
      NOW
    )!;
    expect(
      decideSession(first.state, { type: 'STOPPED', proof: stopProof(), reason: 'loss' }, NOW)
    ).toBeUndefined();
  });

  it('queued + DEADLINE past the delivery deadline fails without extending it', () => {
    const decision = decideSession(bound([queued('m1', NOW - 1)]), { type: 'DEADLINE' }, NOW);
    const message = firstMessage(decision);
    expect(message?.state.kind).toBe('failed');
    expect(message?.state.kind === 'failed' && message.state.reason).toBe('delivery_deadline');
  });

  it('accepted + DEADLINE past the execution deadline fails', () => {
    const decision = decideSession(bound([accepted('m1', NOW - 1)]), { type: 'DEADLINE' }, NOW);
    expect(firstMessage(decision)?.state.kind).toBe('failed');
  });

  it('RECORD_CANCELLATION preserves the durable cancellation marker', () => {
    const decision = decideSession(
      bound([queued()]),
      {
        type: 'RECORD_CANCELLATION',
        messageId: 'm1',
        operationId: 'cancel-op',
        deadlineAt: NOW + 1_000,
      },
      NOW
    );
    expect(decision?.state.messages[0]?.cancellation).toEqual({
      operationId: 'cancel-op',
      deadlineAt: NOW + 1_000,
    });
  });

  it('RECORD_PROOF records proofs on a terminal message without effects', () => {
    const terminal = decideSession(
      bound([accepted()]),
      {
        type: 'OUTCOME',
        messageId: 'm1',
        status: 'completed',
        at: NOW,
        source: 'wrapper_outcome',
      },
      NOW
    )!.state;
    const decision = decideSession(
      terminal,
      {
        type: 'RECORD_PROOF',
        messageId: 'm1',
        proofs: {
          prompt: {
            authorization: {
              operation: 'session.prompt',
              operationId: 'op-1',
              messageId: 'm1',
              session: { sessionId: 's', kiloSessionId: 'k', directory: '/d' },
              wrapperInstanceId: 'w',
              dispatchDeadlineAt: NOW,
            },
            dispatched: true,
          },
        },
      },
      NOW
    );
    const message = firstMessage(decision);
    expect(message?.state.kind).toBe('completed');
    expect(message?.proofs?.prompt?.dispatched).toBe(true);
    expect(decision?.commands).toEqual([]);
  });

  it('a repeated terminal OUTCOME is rejected (never replays)', () => {
    const first = decideSession(
      bound([accepted()]),
      {
        type: 'OUTCOME',
        messageId: 'm1',
        status: 'completed',
        at: NOW,
        source: 'wrapper_outcome',
      },
      NOW
    )!;
    expect(
      decideSession(
        first.state,
        {
          type: 'OUTCOME',
          messageId: 'm1',
          status: 'completed',
          at: NOW + 1,
          source: 'wrapper_outcome',
        },
        NOW + 1
      )
    ).toBeUndefined();
  });
});
