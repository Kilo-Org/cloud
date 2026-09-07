import { describe, expect, it } from 'vitest';
import type { ControlStopRequest } from '../shared/control-plane-session.js';
import type { SessionOperationAuthorization } from '../shared/sandbox-control-protocol.js';
import {
  recordSessionOperationDispatch,
  recordSessionOperationExecutionDeadline,
  type SessionMessageRecord,
} from './session-message-queue.js';
import { admitSessionStop, type PersistedSessionStop } from './session-stop.js';

const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';
const STOP_ID = '33333333-3333-4333-8333-333333333333';

function message(
  messageId: string,
  state: SessionMessageRecord['state'],
  wrapperInstanceId?: string
): SessionMessageRecord {
  return {
    messageId,
    state,
    ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
    ...(state === 'accepted' ? { executionDeadlineAt: 3_601_000 } : {}),
  };
}

function stopRequest(): ControlStopRequest {
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

function admittedStop(messages: SessionMessageRecord[]): PersistedSessionStop {
  const admitted = admitSessionStop({
    messages,
    request: stopRequest(),
    currentSandboxId: 'sandbox-a',
    currentWrapperInstanceId: RUNTIME_A,
    now: 1_000,
  });
  if (!admitted.stop) throw new Error('Stop was not admitted');
  return admitted.stop;
}

describe('Session Stop admission', () => {
  it('retains the first target and cleanup bound when a lost response is retried after B starts', () => {
    const stop = admittedStop([message('a', 'accepted', RUNTIME_A)]);
    const retry = admitSessionStop({
      messages: [message('a', 'completed', RUNTIME_A), message('b', 'accepted', RUNTIME_B)],
      existing: stop,
      request: stopRequest(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_B,
      now: 2_000,
    });

    expect(retry.receipt).toMatchObject({
      operationId: STOP_ID,
      cleanupDeadlineAt: 11_000,
      targets: [{ messageId: 'a', wrapperInstanceId: RUNTIME_A }],
    });
    expect(retry.messages).toEqual([
      message('a', 'completed', RUNTIME_A),
      message('b', 'accepted', RUNTIME_B),
    ]);
  });

  it('fails closed when a Stop targets an older wrapper incarnation', () => {
    const admission = admitSessionStop({
      messages: [message('a', 'accepted', RUNTIME_A)],
      request: stopRequest(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_B,
      now: 1_000,
    });

    expect(admission.receipt).toMatchObject({
      state: 'rejected',
      message: 'Stop runtime scope is stale',
    });
  });

  it('preserves the first cancellation authority when a later Stop overlaps the same live target', () => {
    const first = admitSessionStop({
      messages: [message('a', 'accepted', RUNTIME_A)],
      request: stopRequest(),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
    });
    if (!first.stop) throw new Error('First Stop was not admitted');
    const second = admitSessionStop({
      messages: first.messages,
      request: {
        ...stopRequest(),
        operationId: '44444444-4444-4444-8444-444444444444',
        cleanupDeadlineAt: 12_000,
      },
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 2_000,
    });

    expect(second.receipt).toMatchObject({
      operationId: '44444444-4444-4444-8444-444444444444',
      state: 'rejected',
      message: 'Stop target already has a cancellation intent',
    });
    expect(first.messages).toMatchObject([
      { messageId: 'a', cancellation: { operationId: STOP_ID, deadlineAt: 11_000 } },
    ]);
  });
});

describe('execution deadline persistence', () => {
  it('does not replace the execution bound with a later dispatch attempt after reconstruction', () => {
    const authorization: SessionOperationAuthorization = {
      operation: 'session.prompt',
      operationId: 'message-a',
      messageId: 'message-a',
      session: { sessionId: 'workspace-a', kiloSessionId: 'kilo-a', directory: '/workspace/a' },
      wrapperInstanceId: RUNTIME_A,
      dispatchDeadlineAt: 31_000,
    };
    const first = recordSessionOperationDispatch(
      [message('message-a', 'queued', RUNTIME_A)],
      authorization
    );
    if (!first) throw new Error('Initial dispatch proof was not recorded');

    const reconstructed = structuredClone(first);
    const replayed = recordSessionOperationDispatch(reconstructed, authorization);

    expect(replayed?.[0]).toMatchObject({ executionDeadlineAt: 3_631_000 });
    expect(replayed?.[0]?.operations?.prompt).toMatchObject({
      executionDeadlineAt: 3_631_000,
    });
  });

  it('keeps an equal-valued cleanup bound separate from execution authority', () => {
    const authorization: SessionOperationAuthorization = {
      operation: 'session.prompt',
      operationId: 'message-a',
      messageId: 'message-a',
      session: { sessionId: 'workspace-a', kiloSessionId: 'kilo-a', directory: '/workspace/a' },
      wrapperInstanceId: RUNTIME_A,
      dispatchDeadlineAt: 11_000,
    };
    const dispatched = recordSessionOperationDispatch(
      [message('message-a', 'queued', RUNTIME_A)],
      authorization
    );
    if (!dispatched) throw new Error('Initial dispatch proof was not recorded');
    const admission = admitSessionStop({
      messages: dispatched,
      request: {
        ...stopRequest(),
        targets: [
          {
            messageId: 'message-a',
            wrapperInstanceId: RUNTIME_A,
            executionDeadlineAt: 3_611_000,
          },
        ],
        cleanupDeadlineAt: 11_000,
      },
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
    });

    expect(admission.receipt).toMatchObject({ cleanupDeadlineAt: 11_000 });
    expect(admission.messages).toMatchObject([{ executionDeadlineAt: 3_611_000 }]);
  });

  it('replaces the dispatch ceiling once with the original wrapper execution boundary', () => {
    const authorization: SessionOperationAuthorization = {
      operation: 'session.prompt',
      operationId: 'message-a',
      messageId: 'message-a',
      session: { sessionId: 'workspace-a', kiloSessionId: 'kilo-a', directory: '/workspace/a' },
      wrapperInstanceId: RUNTIME_A,
      dispatchDeadlineAt: 31_000,
    };
    const dispatched = recordSessionOperationDispatch(
      [message('message-a', 'queued', RUNTIME_A)],
      authorization
    );
    if (!dispatched) throw new Error('Initial dispatch proof was not recorded');

    const started = recordSessionOperationExecutionDeadline(dispatched, authorization, 3_600_500);
    if (!started) throw new Error('Wrapper execution boundary was not recorded');
    const replayedBoundary = recordSessionOperationExecutionDeadline(
      started,
      authorization,
      3_700_000
    );
    if (!replayedBoundary) throw new Error('Stored execution boundary was not preserved');
    const recovered = recordSessionOperationDispatch(
      structuredClone(replayedBoundary),
      authorization
    );

    expect(recovered).toMatchObject([{ executionDeadlineAt: 3_600_500 }]);
    expect(recovered?.[0]?.operations?.prompt).toMatchObject({ executionDeadlineAt: 3_600_500 });
  });
});
