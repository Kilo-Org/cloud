import { describe, expect, it } from 'vitest';
import {
  beginRecovery,
  claimAttempt,
  commitRecoveryActivation,
  failAttempt,
  recoveryDeadlines,
  replaceRecoveryAuthority,
  sameRuntime,
} from './control-recovery.js';

const first = {
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  providerInstanceId: 'allocation_a',
  wrapperInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  recoveryCapable: true,
};

describe('control recovery', () => {
  it('retains one deadline and moves its authority only to the same wrapper runtime', () => {
    const started = beginRecovery(undefined, first, 'control_disconnected', 10_000);
    const replacement = {
      ...first,
      connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };

    const retained = beginRecovery(started, replacement, 'control_disconnected', 20_000);

    expect(retained).toMatchObject({
      episodeId: started.episodeId,
      startedAt: 10_000,
      deadlineAt: started.deadlineAt,
      connectionId: replacement.connectionId,
    });
    expect(sameRuntime(first, replacement)).toBe(true);
    expect(
      sameRuntime(first, {
        ...replacement,
        wrapperInstanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      })
    ).toBe(false);
  });

  it('fences old connections and exhausts bounded retries without extending the episode', () => {
    const recovery = beginRecovery(undefined, first, 'heartbeat_expired', 10_000);
    expect(
      claimAttempt(recovery, { ...first, connectionId: crypto.randomUUID() }, 10_001)
    ).toBeUndefined();

    const claimed = claimAttempt(recovery, first, 10_001);
    if (!claimed) throw new Error('Expected recovery attempt');
    const retry = failAttempt(claimed.recovery, 10_002);
    expect(retry.deadlineAt).toBe(recovery.deadlineAt);
    expect(retry.nextAttemptAt).toBeDefined();

    const exhausted = failAttempt({ ...retry, attempt: 3 }, 10_003);
    expect(exhausted.exhaustedAt).toBe(10_003);
    expect(recoveryDeadlines({}, [exhausted], 10_003)).toEqual({ recoveryRetry: 10_003 });
  });

  it('retains an activation receipt for the original attempt until its matching commit reply', () => {
    const recovery = beginRecovery(undefined, first, 'control_disconnected', 10_000);
    const claimed = claimAttempt(recovery, first, 10_001);
    if (!claimed) throw new Error('Expected recovery attempt');

    const committed = commitRecoveryActivation(claimed.recovery, 10_002);
    const replay = claimAttempt(committed, first, 10_003);
    if (!replay) throw new Error('Expected activation repair attempt');

    expect(committed).toMatchObject({
      episodeId: recovery.episodeId,
      attempt: claimed.recovery.attempt,
      activationCommittedAt: 10_002,
    });
    expect(replay).toMatchObject({
      recovery: {
        episodeId: recovery.episodeId,
        attempt: claimed.recovery.attempt,
        activationCommittedAt: 10_002,
        activationCommitAttempts: 1,
      },
    });
    expect(recoveryDeadlines({}, [committed], 10_002)).toEqual({
      recoveryExpiry: 100_002,
      recoveryRetry: 10_002,
    });
    expect(failAttempt({ ...replay.recovery, activationCommitAttempts: 3 }, 10_004)).toMatchObject({
      exhaustedAt: 10_004,
      activationCommittedAt: 10_002,
    });
  });

  it('retains a Session execution bound independently from recovery observation timing', () => {
    const recovery = beginRecovery(undefined, first, 'control_disconnected', 10_000);
    const authority = {
      source: 'session_control_state' as const,
      observedAt: 10_100,
      allocation: { providerRef: first.providerInstanceId },
      scopes: [
        {
          sessionId: 'workspace_a',
          kiloSessionId: 'kilo_a',
          directory: '/workspace/a',
          messageId: 'msg_a',
          wrapperInstanceId: first.wrapperInstanceId,
          executionDeadlineAt: recovery.deadlineAt,
        },
      ],
      stops: [],
      wholeAllocation: true,
    };

    const reconciled = replaceRecoveryAuthority(recovery, authority);
    const replacement = beginRecovery(
      reconciled,
      { ...first, connectionId: crypto.randomUUID() },
      'control_disconnected',
      10_200
    );

    expect(replacement.deadlineAt).toBe(recovery.deadlineAt);
    expect(replacement.authority?.scopes[0]).toMatchObject({
      messageId: 'msg_a',
      executionDeadlineAt: recovery.deadlineAt,
    });
  });
});
