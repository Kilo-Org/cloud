import { describe, expect, it } from 'vitest';
import {
  beginRecovery,
  canRepairActivation,
  claimAttempt,
  commitRecoveryActivation,
  failAttempt,
  recoveryDeadlines,
  replaceRecoveryAuthority,
  sameRuntime,
  wireRecovery,
  type RecoveryAuthority,
  type SandboxRecoveryDecision,
} from './control-recovery.js';

const first = {
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  providerInstanceId: 'allocation_a',
  wrapperInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  recoveryCapable: true,
};

describe('exhausted scoped activation repair', () => {
  const session = { sessionId: 'workspace_b', kiloSessionId: 'kilo_b', directory: '/workspace/b' };
  const scope = {
    ...session,
    messageId: 'message_b',
    wrapperInstanceId: first.wrapperInstanceId,
    executionDeadlineAt: 60_000,
    authorization: {
      operation: 'session.prompt' as const,
      operationId: 'message_b',
      messageId: 'message_b',
      session,
      wrapperInstanceId: first.wrapperInstanceId,
      dispatchDeadlineAt: 15_000,
    },
  };
  const authority: RecoveryAuthority = {
    source: 'session_control_state',
    observedAt: 10_000,
    allocation: { providerRef: first.providerInstanceId },
    roots: [{ ...session, ownerId: 'owner_b', observation: 'known', decision: 'ready' }],
    scopes: [scope],
    stops: [],
    wholeAllocation: false,
  };
  const original = commitRecoveryActivation(
    { ...beginRecovery(undefined, first, 'control_disconnected', 10_000), attempt: 1, authority },
    10_001
  );
  const exhausted: SandboxRecoveryDecision = {
    ...original,
    attempt: 3,
    exhaustedAt: 13_000,
    cleanupState: 'targeted',
    cleanupDeadlineAt: 43_000,
    nextAttemptAt: 20_000,
    activationCommitAttempts: 1,
    activationAcknowledgedAt: 10_002,
  };

  it('preserves the original receipt, ACK budget and independent cleanup schedule on reconnect', () => {
    const connection = { ...first, connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const rebound = beginRecovery(exhausted, connection, 'control_disconnected', 14_000);
    expect(rebound).toEqual({
      ...exhausted,
      connectionId: connection.connectionId,
      activationAcknowledgedAt: undefined,
    });
    expect(claimAttempt(rebound, first, 14_000)).toBeUndefined();
    const claimed = claimAttempt(rebound, connection, 14_000);
    if (!claimed) throw new Error('Expected exhausted activation repair');
    expect(claimed.recovery).toMatchObject({
      attempt: 3,
      activationCommitAttempt: 1,
      activationCommitAttempts: 2,
      nextAttemptAt: 20_000,
    });
    expect(wireRecovery(claimed.recovery)).toEqual(wireRecovery(original));
    const retry = failAttempt(claimed.recovery, 14_001);
    expect(retry).toEqual({
      ...claimed.recovery,
      activationCommitNextAttemptAt: 15_001,
    });
    expect(recoveryDeadlines({}, [retry], 14_001)).toEqual({
      recoveryExpiry: original.activationCommitDeadlineAt,
      recoveryRetry: 15_001,
    });
    expect(claimAttempt(retry, connection, 15_000)).toBeUndefined();
    const last = claimAttempt(retry, connection, 15_001);
    if (!last) throw new Error('Expected final activation repair');
    const failed = failAttempt(last.recovery, 15_002);
    expect(failed).toEqual(last.recovery);
    expect(failed.activationCommitAttempts).toBe(3);
    expect(claimAttempt(failed, connection, 15_003)).toBeUndefined();
    expect(recoveryDeadlines({}, [failed], 15_003)).toEqual({ recoveryRetry: 20_000 });
  });

  it.each<{ name: string; patch: Partial<SandboxRecoveryDecision>; eligible: boolean }>([
    { name: 'ready scope with original authorization', patch: {}, eligible: true },
    {
      name: 'no original commit attempt',
      patch: { activationCommitAttempt: undefined },
      eligible: false,
    },
    { name: 'expired ACK window', patch: { activationCommitDeadlineAt: 20_000 }, eligible: false },
    { name: 'spent ACK budget', patch: { activationCommitAttempts: 3 }, eligible: false },
    { name: 'already acknowledged', patch: { activationAcknowledgedAt: 19_000 }, eligible: false },
    {
      name: 'no prior ready root',
      patch: { authority: { ...authority, roots: [] } },
      eligible: false,
    },
    {
      name: 'no matching scope',
      patch: { authority: { ...authority, scopes: [] } },
      eligible: false,
    },
    {
      name: 'expired original execution bound',
      patch: { authority: { ...authority, scopes: [{ ...scope, executionDeadlineAt: 20_000 }] } },
      eligible: false,
    },
    {
      name: 'missing original authorization',
      patch: { authority: { ...authority, scopes: [{ ...scope, authorization: undefined }] } },
      eligible: false,
    },
    {
      name: 'different wrapper scope',
      patch: {
        authority: { ...authority, scopes: [{ ...scope, wrapperInstanceId: crypto.randomUUID() }] },
      },
      eligible: false,
    },
    {
      name: 'stale ready root',
      patch: {
        authority: {
          ...authority,
          roots: [{ ...session, ownerId: 'owner_b', observation: 'stale', decision: 'ready' }],
        },
      },
      eligible: false,
    },
  ])('$name is eligible: $eligible', ({ patch, eligible }) => {
    const decision = { ...exhausted, activationAcknowledgedAt: undefined, ...patch };
    expect(canRepairActivation(decision, 20_000)).toBe(eligible);
    expect(claimAttempt(decision, first, 20_000) !== undefined).toBe(eligible);
  });
});

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
