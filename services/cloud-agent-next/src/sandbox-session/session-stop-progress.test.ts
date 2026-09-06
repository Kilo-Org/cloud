import { describe, expect, it, vi } from 'vitest';
import type { ControlStopRequest } from '../shared/control-plane-session.js';
import type {
  SessionOperationAck,
  SessionOperationAuthorization,
  SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import type { SessionMessageRecord } from './session-message-queue.js';
import { progressSessionStop } from './session-stop-progress.js';
import { admitSessionStop } from './session-stop.js';

const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';
const STOP_ID = '33333333-3333-4333-8333-333333333333';

function request(): ControlStopRequest {
  return {
    version: 1,
    operationId: STOP_ID,
    scope: { sandboxId: 'sandbox-a', wrapperInstanceId: RUNTIME_A },
    targets: [
      {
        messageId: 'a',
        wrapperInstanceId: RUNTIME_A,
        executionDeadlineAt: 3_601_000,
      },
    ],
    cleanupDeadlineAt: 11_000,
  };
}

function authorization(
  messageId = 'a',
  wrapperInstanceId = RUNTIME_A
): SessionOperationAuthorization {
  return {
    operation: 'session.prompt',
    operationId: messageId,
    messageId,
    session: {
      sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      kiloSessionId: 'ses_11111111111111111111111111',
      directory: '/workspace/a',
    },
    wrapperInstanceId,
    dispatchDeadlineAt: 100_000,
  };
}

function deliveredCompletion(
  authorization: SessionOperationAuthorization
): SessionOperationDelivery {
  return {
    version: 2,
    authorization,
    completedAt: 2_000,
    result: { ok: true, result: {} },
    outcome: { messageId: authorization.messageId, status: 'completed' },
    events: [],
    preparing: [],
  };
}

function deliveredFailure(authorization: SessionOperationAuthorization): SessionOperationDelivery {
  return {
    version: 2,
    authorization,
    completedAt: 2_000,
    result: {
      ok: false,
      error: { code: 'runtime_unhealthy', message: 'Native execution failed', retryable: false },
    },
    outcome: {
      messageId: authorization.messageId,
      status: 'failed',
      reason: 'Native execution failed',
    },
    events: [],
    preparing: [],
  };
}

function acknowledgement(
  delivery: SessionOperationDelivery,
  state: SessionOperationAck['decision']['state']
): SessionOperationAck {
  return {
    version: 2,
    authorization: delivery.authorization,
    resultHash: 'a'.repeat(64),
    disposition: 'applied',
    decision: { state, at: 2_000 },
  };
}

function dispatchedMessage(authorization: SessionOperationAuthorization): SessionMessageRecord {
  return {
    messageId: authorization.messageId,
    state: 'accepted',
    wrapperInstanceId: authorization.wrapperInstanceId,
    executionDeadlineAt: 3_601_000,
    operations: { prompt: { authorization, dispatched: true } },
  };
}

describe('Session Stop progress', () => {
  it('retries the captured A target without changing B authority after a lost abort response', async () => {
    let messages: SessionMessageRecord[] = [
      {
        messageId: 'a',
        state: 'accepted',
        wrapperInstanceId: RUNTIME_A,
        executionDeadlineAt: 3_601_000,
      },
    ];
    const admitted = admitSessionStop({
      messages,
      request: request(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
    });
    if (!admitted.stop) throw new Error('Stop was not admitted');
    messages = admitted.messages;
    const abort = vi
      .fn()
      .mockRejectedValueOnce(new Error('Response was lost'))
      .mockResolvedValueOnce({ status: 'aborted', quiescent: true });
    const progress = () =>
      progressSessionStop({
        stop: admitted.stop!,
        now: () => 2_000,
        readMessages: () => messages,
        saveMessages: next => {
          messages = next;
          return true;
        },
        abort,
        applyDelivery: async () => undefined,
      });

    await progress();
    messages.push({
      messageId: 'b',
      state: 'accepted',
      wrapperInstanceId: RUNTIME_B,
      executionDeadlineAt: 3_602_000,
    });
    const completed = await progress();

    expect(abort.mock.calls.map(([target]) => target.messageId)).toEqual(['a', 'a']);
    expect(completed.state).toBe('confirmed');
    expect(messages).toMatchObject([
      { messageId: 'a', state: 'cancelled' },
      { messageId: 'b', state: 'accepted', wrapperInstanceId: RUNTIME_B },
    ]);
  });

  it('does not terminalize an abort response without confirmed cleanup', async () => {
    let messages: SessionMessageRecord[] = [
      {
        messageId: 'a',
        state: 'accepted',
        wrapperInstanceId: RUNTIME_A,
        executionDeadlineAt: 3_601_000,
      },
    ];
    const admitted = admitSessionStop({
      messages,
      request: request(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
    });
    if (!admitted.stop) throw new Error('Stop was not admitted');
    messages = admitted.messages;

    const progressed = await progressSessionStop({
      stop: admitted.stop,
      now: () => 2_000,
      readMessages: () => messages,
      saveMessages: next => {
        messages = next;
        return true;
      },
      abort: async () => ({ status: 'aborted', quiescent: false }),
      applyDelivery: async () => undefined,
    });

    expect(progressed.state).toBe('accepted');
    expect(messages).toMatchObject([{ messageId: 'a', state: 'accepted' }]);
  });

  it('keeps Stop unconfirmed for a failed retained result without cleanup proof', async () => {
    const original = authorization();
    const delivery = deliveredFailure(original);
    let messages: SessionMessageRecord[] = [dispatchedMessage(original)];
    const admitted = admitSessionStop({
      messages,
      request: request(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
    });
    if (!admitted.stop) throw new Error('Stop was not admitted');
    messages = admitted.messages;

    const progressed = await progressSessionStop({
      stop: admitted.stop,
      now: () => 2_000,
      readMessages: () => messages,
      saveMessages: next => {
        messages = next;
        return true;
      },
      abort: async () => ({ status: 'unconfirmed', quiescent: false, delivery }),
      applyDelivery: async () => {
        messages = messages.map(message =>
          message.messageId === 'a'
            ? { ...message, state: 'failed', terminalSource: 'operation_result', terminalAt: 2_000 }
            : message
        );
        return acknowledgement(delivery, 'failed');
      },
    });

    expect(progressed.state).toBe('accepted');
    expect(messages).toMatchObject([
      { messageId: 'a', state: 'failed', terminalSource: 'operation_result' },
    ]);
  });

  it('does not treat a mismatched delivery as cleanup for the Stop target', async () => {
    const original = authorization();
    const mismatched = deliveredCompletion(authorization('b', RUNTIME_B));
    let messages: SessionMessageRecord[] = [dispatchedMessage(original)];
    const admitted = admitSessionStop({
      messages,
      request: request(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
    });
    if (!admitted.stop) throw new Error('Stop was not admitted');
    messages = admitted.messages;

    const progressed = await progressSessionStop({
      stop: admitted.stop,
      now: () => 2_000,
      readMessages: () => messages,
      saveMessages: next => {
        messages = next;
        return true;
      },
      abort: async () => ({ status: 'unconfirmed', quiescent: false, delivery: mismatched }),
      applyDelivery: async () => {
        messages = messages.map(message =>
          message.messageId === 'a'
            ? {
                ...message,
                state: 'completed',
                terminalSource: 'wrapper_outcome',
                terminalAt: 2_000,
              }
            : message
        );
        return acknowledgement(mismatched, 'completed');
      },
    });

    expect(progressed.state).toBe('accepted');
  });

  it('confirms Stop when the original completed delivery is acknowledged during Stop', async () => {
    const original = authorization();
    const delivery = deliveredCompletion(original);
    let messages: SessionMessageRecord[] = [dispatchedMessage(original)];
    const admitted = admitSessionStop({
      messages,
      request: request(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
    });
    if (!admitted.stop) throw new Error('Stop was not admitted');
    messages = admitted.messages;

    const progressed = await progressSessionStop({
      stop: admitted.stop,
      now: () => 2_000,
      readMessages: () => messages,
      saveMessages: next => {
        messages = next;
        return true;
      },
      abort: async () => ({ status: 'unconfirmed', quiescent: false, delivery }),
      applyDelivery: async () => {
        messages = messages.map(message =>
          message.messageId === 'a'
            ? {
                ...message,
                state: 'completed',
                terminalSource: 'operation_result',
                terminalAt: 2_000,
              }
            : message
        );
        return acknowledgement(delivery, 'completed');
      },
    });

    expect(progressed.state).toBe('confirmed');
    expect(messages).toMatchObject([
      { messageId: 'a', state: 'completed', terminalSource: 'operation_result' },
    ]);
  });
});
