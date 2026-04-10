import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkerDb } = vi.hoisted(() => ({
  mockGetWorkerDb: vi.fn(),
}));

vi.mock('@kilocode/db', () => ({
  getWorkerDb: mockGetWorkerDb,
}));

import { runSweep } from './lifecycle.js';
import type { BillingWorkerEnv } from './types.js';

let loggedValues: unknown[] = [];

type SelectResult<T> = Promise<T[]> & {
  limit: ReturnType<typeof vi.fn>;
};

type SelectBuilder = {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function createSelectResult<T>(rows: T[]): SelectResult<T> {
  const result = Promise.resolve(rows) as SelectResult<T>;
  result.limit = vi.fn(async () => rows);
  return result;
}

function createMockDb(selectResults: unknown[][]) {
  const updates: Array<Record<string, unknown>> = [];
  const txUpdates: Array<Record<string, unknown>> = [];
  const deletes: unknown[] = [];
  const txDeletes: unknown[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const nextSelectResult = () => createSelectResult(selectResults.shift() ?? []);
  const createSelectBuilder = (): SelectBuilder => {
    const builder: SelectBuilder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => nextSelectResult()),
      limit: vi.fn(async () => selectResults.shift() ?? []),
    };
    return builder;
  };
  const select = vi.fn(() => createSelectBuilder());
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      return {
        where: vi.fn(async () => undefined),
      };
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      inserts.push(values);
      return {
        onConflictDoNothing: vi.fn(async () => ({ rowCount: 1 })),
      };
    }),
  }));
  const deleteFrom = vi.fn(() => ({
    where: vi.fn(async whereArg => {
      deletes.push(whereArg);
      return undefined;
    }),
  }));
  const transaction = vi.fn(
    async (
      callback: (tx: {
        delete: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      }) => Promise<unknown>
    ) =>
      callback({
        delete: vi.fn(() => ({
          where: vi.fn(async whereArg => {
            txDeletes.push(whereArg);
            return undefined;
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn((values: Record<string, unknown>) => {
            txUpdates.push(values);
            return {
              where: vi.fn(async () => undefined),
            };
          }),
        })),
      })
  );

  return {
    db: {
      select,
      update,
      insert,
      delete: deleteFrom,
      transaction,
    },
    updates,
    txUpdates,
    deletes,
    txDeletes,
    inserts,
  };
}

function createEnv(fetchImpl: BillingWorkerEnv['KILOCLAW']['fetch']): BillingWorkerEnv {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    LIFECYCLE_QUEUE: {
      send: vi.fn(),
    } as never,
    KILOCLAW: {
      fetch: fetchImpl,
    },
    KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
    INTERNAL_API_SECRET: 'next-secret',
    KILOCLAW_INTERNAL_API_SECRET: 'claw-secret',
  };
}

describe('interrupted auto-resume sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('requests async start and only records retry metadata on acceptance', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    const { db, updates } = createMockDb([
      [{ user_id: 'user-1', instance_id: instanceId, auto_resume_attempt_count: 0 }],
      [{ id: instanceId, sandbox_id: sandboxId }],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toContain(`/api/platform/start-async?instanceId=${instanceId}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sweep: 'interrupted_auto_resume',
      },
      1
    );

    expect(summary.interrupted_auto_resume_requests).toBe(1);
    expect(summary.errors).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        auto_resume_attempt_count: 1,
      })
    );
    expect(updates[0].auto_resume_requested_at).toEqual(expect.any(String));
    expect(updates[0].auto_resume_retry_after).toEqual(expect.any(String));
    expect(updates[0]).not.toHaveProperty('suspended_at');
    expect(updates[0]).not.toHaveProperty('destruction_deadline');
  });

  it('keeps rows suspended when async resume request fails', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    const { db, updates } = createMockDb([
      [{ user_id: 'user-1', instance_id: instanceId, auto_resume_attempt_count: 1 }],
      [{ id: instanceId, sandbox_id: sandboxId }],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(
      async () =>
        new Response('start failed', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        })
    );

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sweep: 'interrupted_auto_resume',
      },
      1
    );

    expect(summary.interrupted_auto_resume_requests).toBe(0);
    expect(summary.errors).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        auto_resume_attempt_count: 2,
      })
    );
    expect(updates[0].auto_resume_requested_at).toEqual(expect.any(String));
    expect(updates[0].auto_resume_retry_after).toEqual(expect.any(String));
    expect(updates[0]).not.toHaveProperty('suspended_at');
    expect(updates[0]).not.toHaveProperty('destruction_deadline');
  });

  it('keeps 404 from async resume request on the normal failure path', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    const { db, updates } = createMockDb([
      [{ user_id: 'user-1', instance_id: instanceId, auto_resume_attempt_count: 0 }],
      [{ id: instanceId, sandbox_id: sandboxId }],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(
      async () =>
        new Response('start target missing', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        })
    );

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        sweep: 'interrupted_auto_resume',
      },
      1
    );

    expect(summary.interrupted_auto_resume_requests).toBe(0);
    expect(summary.errors).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        auto_resume_attempt_count: 1,
      })
    );
  });

  it('clears stale suspension state when no active instance remains', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, updates, txUpdates, txDeletes } = createMockDb([
      [{ user_id: 'user-1', instance_id: instanceId, auto_resume_attempt_count: 1 }],
      [],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        sweep: 'interrupted_auto_resume',
      },
      1
    );

    expect(summary.interrupted_auto_resume_requests).toBe(1);
    expect(summary.errors).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(txDeletes).toHaveLength(1);
    expect(txUpdates).toEqual([
      {
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
      },
    ]);
  });
});

describe('instance destruction sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    loggedValues = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      loggedValues.push(value);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ sent: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
  });

  it('keeps DB/email cleanup unchanged when platform destroy succeeds', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, updates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
          email: 'user-1@example.com',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        sweep: 'instance_destruction',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.sweep3_instance_destruction).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([
      {
        user_id: 'user-1',
        email_type: 'claw_instance_destroyed',
      },
    ]);
    expect(updates).toHaveLength(2);
    expect(updates[0].destroyed_at).toEqual(expect.any(String));
    expect(updates[1]).toEqual({ destruction_deadline: null });
    expect(deletes).toHaveLength(1);
  });

  it('treats platform destroy 404 as already gone and continues with later rows', async () => {
    const firstInstanceId = '11111111-1111-4111-8111-111111111111';
    const secondInstanceId = '22222222-2222-4222-8222-222222222222';
    const { db, updates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: firstInstanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
          email: 'user-1@example.com',
        },
        {
          id: 'sub-2',
          user_id: 'user-2',
          instance_id: secondInstanceId,
          sandbox_id: 'ki_22222222222242228222222222222222',
          email: 'user-2@example.com',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi
      .fn<BillingWorkerEnv['KILOCLAW']['fetch']>()
      .mockResolvedValueOnce(
        new Response('missing', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        sweep: 'instance_destruction',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.sweep3_instance_destruction).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(loggedValues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Kiloclaw platform call failed',
          statusCode: 404,
        }),
      ])
    );
    expect(inserts).toEqual([
      { user_id: 'user-1', email_type: 'claw_instance_destroyed' },
      { user_id: 'user-2', email_type: 'claw_instance_destroyed' },
    ]);
    expect(updates).toHaveLength(4);
    expect(updates[0].destroyed_at).toEqual(expect.any(String));
    expect(updates[1]).toEqual({ destruction_deadline: null });
    expect(updates[2].destroyed_at).toEqual(expect.any(String));
    expect(updates[3]).toEqual({ destruction_deadline: null });
    expect(deletes).toHaveLength(2);
  });

  it('logs non-404 platform destroy failures and preserves billing state transition', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, updates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
          email: 'user-1@example.com',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(
      async () =>
        new Response('destroy failed', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        })
    );

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: '12121212-1212-4212-8212-121212121212',
        sweep: 'instance_destruction',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.sweep3_instance_destruction).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([
      {
        user_id: 'user-1',
        email_type: 'claw_instance_destroyed',
      },
    ]);
    expect(updates).toHaveLength(2);
    expect(updates[0].destroyed_at).toEqual(expect.any(String));
    expect(updates[1]).toEqual({ destruction_deadline: null });
    expect(deletes).toHaveLength(1);
    expect(loggedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Kiloclaw platform call failed',
          statusCode: 500,
        }),
        expect.objectContaining({
          message: 'Destroy instance during billing enforcement failed',
          statusCode: 500,
        }),
      ])
    );
  });
});
