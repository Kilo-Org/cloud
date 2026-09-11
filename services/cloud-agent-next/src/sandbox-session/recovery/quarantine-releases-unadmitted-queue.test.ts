import { describe, expect, it } from 'vitest';
import {
  ATTACH_FAILURE_LIMIT,
  failWaitingMessages,
  nextQueuedMessageId,
  releaseUnadmittedWaitingMessages,
  type SessionMessageRecord,
  type SessionOperationProof,
} from '../session-message-queue.js';

describe('quarantine releases unadmitted queued messages', () => {
  const wrapperA = 'wrapper-a';
  const wrapperB = 'wrapper-b';

  function queued(
    messageId: string,
    overrides: Partial<SessionMessageRecord> = {}
  ): SessionMessageRecord {
    return {
      messageId,
      state: 'queued' as const,
      wrapperInstanceId: wrapperA,
      ...overrides,
    } as SessionMessageRecord;
  }

  it('releases a queued message with retryable not_ready attach failure and no prompt', () => {
    const messages: SessionMessageRecord[] = [queued('unadmitted', { attachFailures: 1 })];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    expect(releasedIds).toEqual(['unadmitted']);
    expect(released[0]).toEqual(
      expect.objectContaining({
        messageId: 'unadmitted',
        state: 'queued',
        wrapperInstanceId: undefined,
        attachFailures: 1,
      })
    );
    expect(released[0].wrapperInstanceId).toBeUndefined();
  });

  it('still fails an accepted message on the same wrapper', () => {
    const messages: SessionMessageRecord[] = [
      { messageId: 'accepted', state: 'accepted', acceptedAt: 5, wrapperInstanceId: wrapperA },
      queued('unadmitted', { attachFailures: 1 }),
    ];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    // Accepted message is untouched by release — only queued unadmitted are released
    expect(releasedIds).toEqual(['unadmitted']);
    const accepted = released.find(m => m.messageId === 'accepted');
    expect(accepted?.state).toBe('accepted');
    expect(accepted?.wrapperInstanceId).toBe(wrapperA);

    // failWaitingMessages then fails the accepted message
    const { failedIds } = failWaitingMessages(released, 'kilo_unhealthy', wrapperA, false);
    expect(failedIds).toEqual(['accepted']);
  });

  it('does not release a queued message with a committed attach', () => {
    const attachProof = {
      authorization: {},
      dispatched: true,
      completedAt: 100,
      attachmentEpoch: 1,
    } as SessionOperationProof;
    const messages: SessionMessageRecord[] = [
      queued('attached', { operations: { attach: attachProof } }),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('does not release a queued message that has a prompt operation', () => {
    const promptProof = {
      authorization: {},
      dispatched: true,
    } as SessionOperationProof;
    const messages: SessionMessageRecord[] = [
      queued('prompted', { operations: { prompt: promptProof } }),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('does not release a queued message with exhausted attach failures', () => {
    const messages: SessionMessageRecord[] = [
      queued('exhausted', { attachFailures: ATTACH_FAILURE_LIMIT }),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('does not release messages bound to a different wrapper', () => {
    const messages: SessionMessageRecord[] = [
      queued('other-wrapper', { wrapperInstanceId: wrapperB }),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('does not release unassigned queued messages', () => {
    const messages: SessionMessageRecord[] = [
      queued('unassigned', { wrapperInstanceId: undefined }),
    ];

    const { releasedIds } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(releasedIds).toEqual([]);
  });

  it('released message is picked up by drain against wrapper B', () => {
    const messages: SessionMessageRecord[] = [queued('unadmitted', { attachFailures: 1 })];

    const { messages: released } = releaseUnadmittedWaitingMessages(messages, wrapperA);

    // After release, message is queued and unassigned — nextQueuedMessageId finds it
    expect(nextQueuedMessageId(released)).toBe('unadmitted');

    // The message can be bound to wrapper B by the normal delivery path
    const rebound = released.map(m =>
      m.messageId === 'unadmitted' ? { ...m, wrapperInstanceId: wrapperB } : m
    );
    expect(rebound[0].wrapperInstanceId).toBe(wrapperB);
  });

  it('preserves completed and failed history', () => {
    const messages: SessionMessageRecord[] = [
      { messageId: 'done', state: 'completed' },
      { messageId: 'old-fail', state: 'failed', failedReason: 'prompt_exhausted' },
      queued('unadmitted'),
    ];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    expect(releasedIds).toEqual(['unadmitted']);
    expect(released[0]).toEqual({ messageId: 'done', state: 'completed' });
    expect(released[1]).toEqual({
      messageId: 'old-fail',
      state: 'failed',
      failedReason: 'prompt_exhausted',
    });
  });

  it('clears preparationAttemptId and deliveryDeadlineAt on release', () => {
    const messages: SessionMessageRecord[] = [
      queued('unadmitted', {
        preparationAttemptId: 'attempt-1',
        deliveryDeadlineAt: 999_999,
        attachFailures: 1,
      }),
    ];

    const { messages: released } = releaseUnadmittedWaitingMessages(messages, wrapperA);
    expect(released[0].preparationAttemptId).toBeUndefined();
    expect(released[0].deliveryDeadlineAt).toBeUndefined();
  });

  it('drops incomplete attach proofs on release', () => {
    const attachProof = {
      authorization: {},
      dispatched: false,
    } as SessionOperationProof;
    const messages: SessionMessageRecord[] = [
      queued('unadmitted', { attachFailures: 1, operations: { attach: attachProof } }),
    ];

    const { messages: released, releasedIds } = releaseUnadmittedWaitingMessages(
      messages,
      wrapperA
    );

    expect(releasedIds).toEqual(['unadmitted']);
    expect(released[0].operations).toBeUndefined();
  });
});
