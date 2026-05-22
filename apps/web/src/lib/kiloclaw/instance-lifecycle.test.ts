jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import {
  autoResumeIfSuspended,
  clearTrialInactivityStopAfterStart,
  completeAutoResumeIfReady,
} from './instance-lifecycle';

const selectResultsQueue: unknown[][] = [];
const updateSetCalls: Array<Record<string, unknown>> = [];
const txUpdateSetCalls: Array<Record<string, unknown>> = [];
const txInsertValues: Array<Record<string, unknown>> = [];
const deleteWhereCalls: unknown[] = [];
const startAsyncMock = jest.fn();

function createSelectResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  const result: {
    limit: jest.Mock;
    for: jest.Mock;
    then: typeof promise.then;
  } = {
    limit: jest.fn().mockResolvedValue(rows),
    // Drizzle's `.for('update')` row-locks and returns the same shape as
    // the parent select. Tests just need the rows; the lock semantics are
    // exercised by the transaction integration test fixtures.
    for: jest.fn(() => result),
    then: promise.then.bind(promise),
  };
  return result;
}

function createWhereResult<T>(rows: T[]) {
  const promise = Promise.resolve(undefined);
  return {
    returning: jest.fn().mockResolvedValue(rows),
    then: promise.then.bind(promise),
  };
}

type MockDb = {
  select: jest.Mock;
  update: jest.Mock;
  transaction: jest.Mock;
};

const mockDb = db as unknown as MockDb;

describe('instance lifecycle async resume', () => {
  beforeEach(() => {
    selectResultsQueue.length = 0;
    updateSetCalls.length = 0;
    txUpdateSetCalls.length = 0;
    txInsertValues.length = 0;
    deleteWhereCalls.length = 0;
    startAsyncMock.mockReset();
    jest.mocked(KiloClawInternalClient).mockImplementation(
      () =>
        ({
          startAsync: startAsyncMock,
        }) as never
    );

    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => ({
      from: jest.fn(() => {
        const whereResult = createSelectResult(selectResultsQueue.shift() ?? []);
        return {
          leftJoin: jest.fn(() => ({
            where: jest.fn(() => whereResult),
          })),
          where: jest.fn(() => whereResult),
        };
      }),
    }));

    mockDb.update.mockReset();
    mockDb.update.mockImplementation(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        const whereResult = createWhereResult([{}]);
        return {
          where: jest.fn(() => whereResult),
        };
      }),
    }));

    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async callback => {
      const tx = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => createSelectResult(selectResultsQueue.shift() ?? [])),
          })),
        })),
        delete: jest.fn(() => ({
          where: jest.fn(async (whereArg: unknown) => {
            deleteWhereCalls.push(whereArg);
            return undefined;
          }),
        })),
        update: jest.fn(() => ({
          set: jest.fn((values: Record<string, unknown>) => {
            txUpdateSetCalls.push(values);
            const whereResult = createWhereResult([{}]);
            return {
              where: jest.fn(() => whereResult),
            };
          }),
        })),
        insert: jest.fn(() => ({
          values: jest.fn(async (values: Record<string, unknown>) => {
            txInsertValues.push(values);
            return undefined;
          }),
        })),
      };

      return callback(tx);
    });

    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests async auto-resume without clearing suspension immediately', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      [{ auto_resume_attempt_count: 0 }]
    );
    startAsyncMock.mockResolvedValueOnce({ ok: true });

    await autoResumeIfSuspended('user-1', instanceId);

    expect(startAsyncMock).toHaveBeenCalledWith('user-1', instanceId, {
      reason: 'interrupted_auto_resume',
    });
    expect(updateSetCalls).toHaveLength(1);
    expect(updateSetCalls[0]).toEqual(
      expect.objectContaining({
        auto_resume_attempt_count: 1,
      })
    );
    expect(updateSetCalls[0].auto_resume_requested_at).toEqual(expect.any(String));
    expect(updateSetCalls[0].auto_resume_retry_after).toEqual(expect.any(String));
    expect(updateSetCalls[0]).not.toHaveProperty('suspended_at');
    expect(updateSetCalls[0]).not.toHaveProperty('destruction_deadline');
  });

  it('clears stale suspension state when no active instance remains', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    selectResultsQueue.push(
      [],
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          plan: 'trial',
          status: 'canceled',
          suspended_at: '2026-04-07T20:00:00.000Z',
          destruction_deadline: '2026-04-14T20:00:00.000Z',
        },
      ]
    );

    await autoResumeIfSuspended('user-1', instanceId);

    expect(startAsyncMock).not.toHaveBeenCalled();
    expect(updateSetCalls).toHaveLength(0);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(deleteWhereCalls).toHaveLength(1);
    expect(txUpdateSetCalls).toEqual([
      {
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
      },
    ]);
    expect(txInsertValues).toHaveLength(1);
    expect(txInsertValues[0]).toEqual(
      expect.objectContaining({
        actor_id: 'web-instance-lifecycle',
        action: 'reactivated',
        reason: 'auto_resume_aborted_no_active_instance',
      })
    );
  });

  it('completes async auto-resume for an active subscription and clears retry state', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      [
        {
          status: 'active',
          suspended_at: '2026-04-07T20:00:00.000Z',
          auto_resume_requested_at: '2026-04-07T20:05:00.000Z',
          auto_resume_retry_after: '2026-04-07T22:05:00.000Z',
          auto_resume_attempt_count: 2,
        },
      ],
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          plan: 'standard',
          status: 'active',
          suspended_at: '2026-04-07T20:00:00.000Z',
          destruction_deadline: '2026-04-14T20:00:00.000Z',
          auto_resume_requested_at: '2026-04-07T20:05:00.000Z',
          auto_resume_retry_after: '2026-04-07T22:05:00.000Z',
          auto_resume_attempt_count: 2,
        },
      ]
    );

    const result = await completeAutoResumeIfReady('user-1', sandboxId, instanceId);

    expect(result).toEqual({ instanceId, resumeCompleted: true });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(deleteWhereCalls).toHaveLength(1);
    expect(txUpdateSetCalls).toHaveLength(1);
    expect(txUpdateSetCalls[0]).toEqual({
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
    });
    expect(txInsertValues).toHaveLength(1);
    expect(txInsertValues[0]).toEqual(
      expect.objectContaining({
        actor_id: 'web-instance-lifecycle',
        action: 'reactivated',
        reason: 'auto_resume_completed',
      })
    );
  });

  it('completes async auto-resume readiness for organization-owned instances', async () => {
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const sandboxId = 'ki_22222222222242228222222222222222';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      [
        {
          status: 'active',
          suspended_at: null,
          auto_resume_requested_at: '2026-04-07T20:05:00.000Z',
          auto_resume_retry_after: '2026-04-07T22:05:00.000Z',
          auto_resume_attempt_count: 1,
        },
      ],
      [
        {
          id: 'sub-org-1',
          user_id: 'user-1',
          instance_id: instanceId,
          plan: 'standard',
          status: 'active',
          suspended_at: null,
          destruction_deadline: null,
          auto_resume_requested_at: '2026-04-07T20:05:00.000Z',
          auto_resume_retry_after: '2026-04-07T22:05:00.000Z',
          auto_resume_attempt_count: 1,
        },
      ]
    );

    const result = await completeAutoResumeIfReady('user-1', sandboxId, instanceId);

    expect(result).toEqual({ instanceId, resumeCompleted: true });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(txUpdateSetCalls[0]).toEqual({
      suspended_at: null,
      destruction_deadline: null,
      auto_resume_requested_at: null,
      auto_resume_retry_after: null,
      auto_resume_attempt_count: 0,
    });
  });

  it('does not clear suspension state for a canceled subscription on stale ready callback', async () => {
    // Regression: a stopped instance suspended by subscription_expiry could be
    // woken by Fly Proxy if the worker proxied to it. The resulting controller
    // checkin would fire the instance-ready callback, and previously this
    // function would treat any non-null suspended_at as a pending auto-resume
    // and wipe both the suspension state and the once-per-lifecycle email log.
    // The next billing sweep would then re-stop and re-email.
    // Per .specs/kiloclaw-billing.md §1132.1, auto-resume completion fires
    // only on a transition to active status.
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      [
        {
          status: 'canceled',
          suspended_at: '2026-04-07T20:00:00.000Z',
          auto_resume_requested_at: null,
          auto_resume_retry_after: null,
          auto_resume_attempt_count: 0,
        },
      ]
    );

    const result = await completeAutoResumeIfReady('user-1', sandboxId, instanceId);

    expect(result).toEqual({ instanceId, resumeCompleted: false });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(txUpdateSetCalls).toHaveLength(0);
    expect(deleteWhereCalls).toHaveLength(0);
    expect(txInsertValues).toHaveLength(0);
  });

  it('aborts the transactional clear if the subscription flips out of active before the row lock acquires', async () => {
    // Regression for the TOCTOU race between the precondition status read
    // in completeAutoResumeIfReady and the transaction inside
    // clearAutoResumeState: if the subscription transitions to past_due or
    // canceled in that window, the in-transaction SELECT FOR UPDATE with
    // status='active' returns empty rows and the entire mutation is
    // skipped. Without this guard the email-log dedupe row and
    // suspended_at would still be wiped on a stale ready callback,
    // reopening the duplicate-suspension-email loop.
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      // Precondition select: subscription was active with pending markers
      // when first read.
      [
        {
          status: 'active',
          suspended_at: '2026-04-07T20:00:00.000Z',
          auto_resume_requested_at: '2026-04-07T20:05:00.000Z',
          auto_resume_retry_after: '2026-04-07T22:05:00.000Z',
          auto_resume_attempt_count: 2,
        },
      ],
      // Transactional SELECT FOR UPDATE with status='active' filter: a
      // concurrent transition committed before our lock, so no rows match.
      []
    );

    const result = await completeAutoResumeIfReady('user-1', sandboxId, instanceId);

    // Race-aborted clear must not be reported as a completion: the caller
    // (instance-ready route) keys its "Completed async auto-resume" log
    // line on resumeCompleted, and conflating skipped-due-to-race with
    // genuine completion would mask the race in operator metrics.
    expect(result).toEqual({ instanceId, resumeCompleted: false });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // No email_log delete, no row update, no change-log insert when the
    // active gate fails inside the transaction.
    expect(deleteWhereCalls).toHaveLength(0);
    expect(txUpdateSetCalls).toHaveLength(0);
    expect(txInsertValues).toHaveLength(0);
  });

  it('does not clear suspension state for a past_due subscription on stale ready callback', async () => {
    // past_due has not transitioned to active yet (the credit-renewal sweep
    // sets status to active before invoking auto-resume). A ready callback
    // arriving while still past_due is stale state, not a recovery signal.
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      [
        {
          status: 'past_due',
          suspended_at: '2026-04-07T20:00:00.000Z',
          auto_resume_requested_at: '2026-04-07T20:05:00.000Z',
          auto_resume_retry_after: '2026-04-07T22:05:00.000Z',
          auto_resume_attempt_count: 1,
        },
      ]
    );

    const result = await completeAutoResumeIfReady('user-1', sandboxId, instanceId);

    expect(result).toEqual({ instanceId, resumeCompleted: false });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(txUpdateSetCalls).toHaveLength(0);
    expect(deleteWhereCalls).toHaveLength(0);
    expect(txInsertValues).toHaveLength(0);
  });

  it('clears auto-resume state when readiness arrives after the instance is already gone', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push([], []);

    const result = await completeAutoResumeIfReady('user-1', sandboxId, instanceId);

    expect(result).toEqual({ instanceId, resumeCompleted: true });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(deleteWhereCalls).toHaveLength(1);
    expect(txUpdateSetCalls).toEqual([
      {
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
      },
    ]);
    expect(txInsertValues).toHaveLength(0);
  });

  it('treats repeated readiness notifications as idempotent once resume state is already clear', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      [
        {
          status: 'active',
          suspended_at: null,
          auto_resume_requested_at: null,
          auto_resume_retry_after: null,
          auto_resume_attempt_count: 0,
        },
      ]
    );

    const result = await completeAutoResumeIfReady('user-1', sandboxId, instanceId);

    expect(result).toEqual({ instanceId, resumeCompleted: false });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(txUpdateSetCalls).toHaveLength(0);
    expect(deleteWhereCalls).toHaveLength(0);
  });
});

describe('clearTrialInactivityStopAfterStart', () => {
  beforeEach(() => {
    selectResultsQueue.length = 0;
    updateSetCalls.length = 0;
    txUpdateSetCalls.length = 0;
    txInsertValues.length = 0;
    deleteWhereCalls.length = 0;
    startAsyncMock.mockReset();
    jest.mocked(KiloClawInternalClient).mockImplementation(
      () =>
        ({
          startAsync: startAsyncMock,
        }) as never
    );

    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => ({
      from: jest.fn(() => {
        const whereResult = createSelectResult(selectResultsQueue.shift() ?? []);
        return {
          leftJoin: jest.fn(() => ({
            where: jest.fn(() => whereResult),
          })),
          where: jest.fn(() => whereResult),
        };
      }),
    }));

    mockDb.update.mockReset();
    mockDb.update.mockImplementation(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        updateSetCalls.push(values);
        const whereResult = createWhereResult([{}]);
        return {
          where: jest.fn(() => whereResult),
        };
      }),
    }));
  });

  it('clears the inactivity marker for a current personal trial subscription', async () => {
    const instanceId = '22222222-2222-4222-8222-222222222222';
    selectResultsQueue.push([
      {
        subscription: {
          user_id: 'user-1',
          instance_id: instanceId,
          plan: 'trial',
          status: 'trialing',
        },
        instance: {
          id: instanceId,
          userId: 'user-1',
          sandboxId: 'ki_22222222222242228222222222222222',
          name: null,
          destroyedAt: null,
          organizationId: null,
        },
      },
    ]);

    const result = await clearTrialInactivityStopAfterStart({
      kiloUserId: 'user-1',
      instanceId,
    });

    expect(result).toBe(true);
    expect(updateSetCalls).toContainEqual({ inactive_trial_stopped_at: null });
  });

  it('does not clear the inactivity marker for non-trial subscriptions', async () => {
    const instanceId = '33333333-3333-4333-8333-333333333333';
    selectResultsQueue.push([
      {
        subscription: {
          user_id: 'user-1',
          instance_id: instanceId,
          plan: 'standard',
          status: 'active',
        },
        instance: {
          id: instanceId,
          userId: 'user-1',
          sandboxId: 'ki_33333333333343338333333333333333',
          name: null,
          destroyedAt: null,
          organizationId: null,
        },
      },
    ]);

    const result = await clearTrialInactivityStopAfterStart({
      kiloUserId: 'user-1',
      instanceId,
    });

    expect(result).toBe(false);
    expect(updateSetCalls).toHaveLength(0);
  });
});
