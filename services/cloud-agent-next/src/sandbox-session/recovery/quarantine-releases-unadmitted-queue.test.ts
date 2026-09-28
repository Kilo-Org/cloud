import { describe, expect, it } from 'vitest';
import {
  ATTACH_FAILURE_LIMIT,
  failWaitingMessages,
  nextQueuedMessageId,
  releaseUnadmittedWaitingMessages,
  type SessionMessage,
  type SessionOperationProof,
} from '../session-message-queue.js';
import { acceptedMessage, queuedMessage, terminalState } from '../session-state.test-helpers.js';

describe('quarantine releases unadmitted queued messages', () => {
  const wrapperA = 'wrapper-a';
  const wrapperB = 'wrapper-b';

  it('releases a queued message with retryable not_ready attach failure and no prompt', () => {
    const messages: SessionMessage[] = [
      queuedMessage('unadmitted', { wrapperInstanceId: wrapperA, attachFailures: 1 }),
    ];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    expect(releasedIds).toEqual(['unadmitted']);
    expect(released[0]).toMatchObject({
      messageId: 'unadmitted',
      state: { kind: 'queued', attachFailures: 1 },
    });
    expect(
      (released[0]!.state as unknown as Record<string, unknown>).wrapperInstanceId
    ).toBeUndefined();
  });

  it('still fails an accepted message on the same wrapper', () => {
    const messages: SessionMessage[] = [
      acceptedMessage('accepted', { acceptedAt: 5, wrapperInstanceId: wrapperA }),
      queuedMessage('unadmitted', { wrapperInstanceId: wrapperA, attachFailures: 1 }),
    ];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    // Accepted message is untouched by release — only queued unadmitted are released
    expect(releasedIds).toEqual(['unadmitted']);
    const accepted = released.find(m => m.messageId === 'accepted');
    expect(accepted?.state.kind).toBe('accepted');
    expect(accepted?.state.kind === 'accepted' && accepted.state.wrapperInstanceId).toBe(wrapperA);

    // failWaitingMessages then fails the accepted message
    const { failedIds } = failWaitingMessages(released, 'kilo_unhealthy', wrapperA, false);
    expect(failedIds).toEqual(['accepted']);
  });

  it('releases a completed attach with no prompt and retires the proof', () => {
    const attachProof = {
      authorization: {},
      dispatched: true,
      completedAt: 100,
      attachmentEpoch: 1,
    } as SessionOperationProof;
    const messages: SessionMessage[] = [
      queuedMessage(
        'attached',
        { wrapperInstanceId: wrapperA, deadlineAt: 7_000 },
        { proofs: { attach: attachProof } }
      ),
    ];

    const { releasedIds, messages: released } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );
    expect(releasedIds).toEqual(['attached']);
    expect(released[0]).toMatchObject({
      state: { kind: 'queued', deadlineAt: 7_000 },
      proofs: { retiredAttach: attachProof },
    });
    expect(released[0]!.proofs?.attach).toBeUndefined();
  });

  it('does not release a queued message that has a prompt operation', () => {
    const promptProof = {
      authorization: {},
      dispatched: true,
    } as SessionOperationProof;
    const messages: SessionMessage[] = [
      queuedMessage(
        'prompted',
        { wrapperInstanceId: wrapperA },
        { proofs: { prompt: promptProof } }
      ),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('does not release a queued message with exhausted attach failures', () => {
    const messages: SessionMessage[] = [
      queuedMessage('exhausted', {
        wrapperInstanceId: wrapperA,
        attachFailures: ATTACH_FAILURE_LIMIT,
      }),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('does not release messages bound to a different wrapper', () => {
    const messages: SessionMessage[] = [
      queuedMessage('other-wrapper', { wrapperInstanceId: wrapperB }),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('does not release unassigned queued messages', () => {
    const messages: SessionMessage[] = [queuedMessage('unassigned')];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('released message is picked up by drain against wrapper B', () => {
    const messages: SessionMessage[] = [
      queuedMessage('unadmitted', { wrapperInstanceId: wrapperA, attachFailures: 1 }),
    ];

    const { messages: released } = releaseUnadmittedWaitingMessages(messages, wrapperA);

    // After release, message is queued and unassigned — nextQueuedMessageId finds it
    expect(nextQueuedMessageId(released)).toBe('unadmitted');

    // The message can be bound to wrapper B by the normal delivery path
    const rebound = released.map(m =>
      m.messageId === 'unadmitted' && m.state.kind === 'queued'
        ? { ...m, state: { ...m.state, wrapperInstanceId: wrapperB } }
        : m
    );
    expect(rebound[0]!.state.kind === 'queued' && rebound[0]!.state.wrapperInstanceId).toBe(
      wrapperB
    );
  });

  it('preserves completed and failed history', () => {
    const messages: SessionMessage[] = [
      { messageId: 'done', state: terminalState('completed') },
      { messageId: 'old-fail', state: terminalState('failed', { reason: 'prompt_exhausted' }) },
      queuedMessage('unadmitted', { wrapperInstanceId: wrapperA }),
    ];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    expect(releasedIds).toEqual(['unadmitted']);
    expect(released[0]).toEqual({ messageId: 'done', state: terminalState('completed') });
    expect(released[1]).toEqual({
      messageId: 'old-fail',
      state: terminalState('failed', { reason: 'prompt_exhausted' }),
    });
  });

  it('clears preparationAttemptId but preserves the preparation bound on release', () => {
    const messages: SessionMessage[] = [
      queuedMessage('unadmitted', {
        wrapperInstanceId: wrapperA,
        preparationAttemptId: 'attempt-1',
        deadlineAt: 999_999,
        attachFailures: 1,
      }),
    ];

    const { messages: released } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    const state = released[0]!.state;
    expect(state.kind === 'queued' && state.preparationAttemptId).toBeUndefined();
    // The head keeps its original preparation bound across release.
    expect(state.kind === 'queued' && state.deadlineAt).toBe(999_999);
  });

  it('drops incomplete attach proofs on release', () => {
    const attachProof = {
      authorization: {},
      dispatched: false,
    } as SessionOperationProof;
    const messages: SessionMessage[] = [
      queuedMessage(
        'unadmitted',
        { wrapperInstanceId: wrapperA, attachFailures: 1 },
        { proofs: { attach: attachProof } }
      ),
    ];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    expect(releasedIds).toEqual(['unadmitted']);
    expect(released[0]!.proofs).toBeUndefined();
  });
});
