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
import { autoResumeIfSuspended, completeAutoResumeIfReady } from './instance-lifecycle';

const selectResultsQueue: unknown[][] = [];
const updateSetCalls: Array<Record<string, unknown>> = [];
const txUpdateSetCalls: Array<Record<string, unknown>> = [];
const txInsertValues: Array<Record<string, unknown>> = [];
const deleteWhereCalls: unknown[] = [];
const startAsyncMock = jest.fn();

function createSelectResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: jest.fn().mockResolvedValue(rows),
    then: promise.then.bind(promise),
  };
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
      from: jest.fn(() => ({
        where: jest.fn(() => createSelectResult(selectResultsQueue.shift() ?? [])),
      })),
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

    expect(startAsyncMock).toHaveBeenCalledWith('user-1', instanceId);
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

  it('completes async auto-resume for the correct instance and clears retry state', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    selectResultsQueue.push(
      [{ id: instanceId, sandbox_id: sandboxId }],
      [
        {
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
          plan: 'trial',
          status: 'canceled',
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
