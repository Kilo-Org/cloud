import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkerDb } = vi.hoisted(() => ({
  mockGetWorkerDb: vi.fn(),
}));

vi.mock('@kilocode/db', async importOriginal => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    getWorkerDb: mockGetWorkerDb,
  };
});

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

function createMockDb(
  selectResults: unknown[][],
  options?: {
    insertRowCounts?: number[];
    txInsertRowCounts?: number[];
    updateReturningRows?: unknown[][];
    txUpdateReturningRows?: unknown[][];
  }
) {
  const updates: Array<Record<string, unknown>> = [];
  const txUpdates: Array<Record<string, unknown>> = [];
  const deletes: unknown[] = [];
  const txDeletes: unknown[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const txInserts: Array<Record<string, unknown>> = [];
  const selectBuilders: SelectBuilder[] = [];
  const insertRowCounts = [...(options?.insertRowCounts ?? [])];
  const txInsertRowCounts = [...(options?.txInsertRowCounts ?? [])];
  const updateReturningRows = [...(options?.updateReturningRows ?? [])];
  const txUpdateReturningRows = [...(options?.txUpdateReturningRows ?? [])];
  const nextSelectResult = () => createSelectResult(selectResults.shift() ?? []);
  const createWhereResult = (returningRows: unknown[]) => {
    const promise = Promise.resolve(undefined);
    return {
      returning: vi.fn(async () => returningRows),
      then: promise.then.bind(promise),
    };
  };
  const createSelectBuilder = (): SelectBuilder => {
    const builder: SelectBuilder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => nextSelectResult()),
      limit: vi.fn(async () => selectResults.shift() ?? []),
    };
    selectBuilders.push(builder);
    return builder;
  };
  const select = vi.fn(() => createSelectBuilder());
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      const whereResult = createWhereResult(updateReturningRows.shift() ?? [{}]);
      return {
        where: vi.fn(() => whereResult),
      };
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      inserts.push(values);
      return {
        onConflictDoNothing: vi.fn(async () => ({ rowCount: insertRowCounts.shift() ?? 1 })),
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
        insert: ReturnType<typeof vi.fn>;
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
        insert: vi.fn(() => ({
          values: vi.fn((values: Record<string, unknown>) => {
            txInserts.push(values);
            return {
              onConflictDoNothing: vi.fn(async () => ({
                rowCount: txInsertRowCounts.shift() ?? 1,
              })),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn((values: Record<string, unknown>) => {
            txUpdates.push(values);
            const whereResult = createWhereResult(txUpdateReturningRows.shift() ?? [{}]);
            return {
              where: vi.fn(() => whereResult),
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
    txInserts,
    selectBuilders,
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
    STRIPE_KILOCLAW_COMMIT_PRICE_ID: 'price_commit',
    STRIPE_KILOCLAW_STANDARD_PRICE_ID: 'price_standard',
    STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID: 'price_standard_intro',
    INTERNAL_API_SECRET: 'next-internal-api-secret',
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

  it('skips detached rows instead of fan-out updates', async () => {
    const { db, updates, txUpdates, txDeletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: null,
          organization_id: null,
          auto_resume_attempt_count: 0,
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'edededed-eded-4ded-8ded-edededededed',
        sweep: 'interrupted_auto_resume',
      },
      1
    );

    expect(summary.interrupted_auto_resume_requests).toBe(0);
    expect(summary.errors).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(txUpdates).toHaveLength(0);
    expect(txDeletes).toHaveLength(0);
  });
});

describe('destruction warning sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ sent: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
  });

  it('sends destruction warning for suspended subscriptions with non-destroyed instances', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const destructionDeadline = '2099-04-15T10:00:00.000Z';
    const { db, inserts, selectBuilders } = createMockDb([
      [
        {
          user_id: 'user-1',
          email: 'user-1@example.com',
          destruction_deadline: destructionDeadline,
          instance_id: instanceId,
          instance_name: 'Research Claw',
          instance_destroyed_at: null,
          plan: 'commit',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '13131313-1313-4313-8313-131313131313',
        sweep: 'destruction_warning',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.destruction_warnings).toBe(1);
    expect(summary.emails_sent).toBe(1);
    expect(selectBuilders[0]?.innerJoin).toHaveBeenCalledTimes(2);
    expect(selectBuilders[0]?.leftJoin).not.toHaveBeenCalled();
    expect(inserts).toEqual([
      {
        user_id: 'user-1',
        instance_id: instanceId,
        email_type: 'claw_destruction_warning',
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      action: string;
      input: Record<string, unknown>;
    };
    expect(body).toEqual({
      action: 'send_email',
      input: {
        to: 'user-1@example.com',
        templateName: 'clawDestructionWarning',
        templateVars: {
          destruction_date: 'April 15, 2099',
          claw_url: 'https://app.kilo.ai/claw',
          instance_label: 'Research Claw',
          instance_id_short: '11111111',
        },
        userId: 'user-1',
        instanceId,
      },
    });
  });

  it('does not send destruction warning when joined instance is destroyed', async () => {
    const { db, inserts } = createMockDb([
      [
        {
          user_id: 'user-1',
          email: 'user-1@example.com',
          destruction_deadline: '2099-04-15T10:00:00.000Z',
          instance_id: '11111111-1111-4111-8111-111111111111',
          instance_name: 'Destroyed Claw',
          instance_destroyed_at: '2099-04-13T10:00:00.000Z',
          plan: 'trial',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '14141414-1414-4414-8414-141414141414',
        sweep: 'destruction_warning',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.destruction_warnings).toBe(0);
    expect(summary.emails_sent).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not create warning log for destroyed instances without a prior warning row', async () => {
    const { db, inserts } = createMockDb([
      [
        {
          user_id: 'user-1',
          email: 'user-1@example.com',
          destruction_deadline: '2099-04-15T10:00:00.000Z',
          instance_id: '22222222-2222-4222-8222-222222222222',
          instance_name: null,
          instance_destroyed_at: '2099-04-13T10:00:00.000Z',
          plan: 'standard',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '15151515-1515-4515-8515-151515151515',
        sweep: 'destruction_warning',
      },
      1
    );

    expect(summary.destruction_warnings).toBe(0);
    expect(summary.emails_skipped).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('counts destruction warnings only when an email is actually sent', async () => {
    const { db, inserts } = createMockDb(
      [
        [
          {
            user_id: 'user-1',
            email: 'user-1@example.com',
            destruction_deadline: '2099-04-15T10:00:00.000Z',
            instance_id: '33333333-3333-4333-8333-333333333333',
            instance_name: null,
            instance_destroyed_at: null,
            plan: 'standard',
          },
        ],
      ],
      { insertRowCounts: [0] }
    );
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '16161616-1616-4616-8616-161616161616',
        sweep: 'destruction_warning',
      },
      1
    );

    expect(summary.destruction_warnings).toBe(0);
    expect(summary.emails_sent).toBe(0);
    expect(summary.emails_skipped).toBe(1);
    expect(inserts).toEqual([
      {
        user_id: 'user-1',
        instance_id: '33333333-3333-4333-8333-333333333333',
        email_type: 'claw_destruction_warning',
      },
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
    expect(inserts).toEqual(
      expect.arrayContaining([
        {
          user_id: 'user-1',
          instance_id: instanceId,
          email_type: 'claw_instance_destroyed',
        },
        expect.objectContaining({
          actor_id: 'billing-lifecycle-job',
          action: 'status_changed',
          reason: 'instance_destroyed',
        }),
      ])
    );
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
    expect(inserts).toEqual(
      expect.arrayContaining([
        {
          user_id: 'user-1',
          instance_id: firstInstanceId,
          email_type: 'claw_instance_destroyed',
        },
        {
          user_id: 'user-2',
          instance_id: secondInstanceId,
          email_type: 'claw_instance_destroyed',
        },
        expect.objectContaining({
          actor_id: 'billing-lifecycle-job',
          action: 'status_changed',
          reason: 'instance_destroyed',
        }),
      ])
    );
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
    expect(inserts).toEqual(
      expect.arrayContaining([
        {
          user_id: 'user-1',
          instance_id: instanceId,
          email_type: 'claw_instance_destroyed',
        },
        expect.objectContaining({
          actor_id: 'billing-lifecycle-job',
          action: 'status_changed',
          reason: 'instance_destroyed',
        }),
      ])
    );
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

  it('skips rows whose linked instance row is missing', async () => {
    const { db, updates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: '11111111-1111-4111-8111-111111111111',
          sandbox_id: null,
          email: 'user-1@example.com',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: '17171717-1717-4717-8717-171717171717',
        sweep: 'instance_destruction',
      },
      1
    );

    expect(summary.sweep3_instance_destruction).toBe(0);
    expect(summary.errors).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});

describe('credit renewal sweep affiliate tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('enqueues a sale affiliate event for pure-credit renewals', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, txInserts, txUpdates } = createMockDb([
      [
        {
          user_id: 'user-1',
          email: 'user-1@example.com',
          instance_id: 'instance-1',
          id: 'sub-1',
          instance_row_id: 'instance-1',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'active',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 50_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: null,
          next_credit_expiration_at: null,
          user_updated_at: '2026-04-09T09:00:00.000Z',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const fetch = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        action: string;
        input: Record<string, unknown>;
      };

      switch (body.action) {
        case 'project_pending_kilo_pass_bonus':
          return new Response(JSON.stringify({ projectedBonusMicrodollars: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        case 'issue_kilo_pass_bonus_from_usage_threshold':
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        case 'enqueue_affiliate_event':
          return new Response(JSON.stringify({ enqueued: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        default:
          throw new Error(`Unexpected side effect action: ${body.action}`);
      }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'abababab-abab-4bab-8bab-abababababab',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(1);
    expect(summary.errors).toBe(0);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kilo_user_id: 'user-1',
          amount_microdollars: -9_000_000,
          description: 'KiloClaw standard renewal',
        }),
        expect.objectContaining({
          actor_id: 'billing-lifecycle-job',
          action: 'period_advanced',
          reason: 'credit_renewal',
        }),
      ])
    );
    expect(txUpdates).toEqual(
      expect.arrayContaining([
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ microdollars_used: expect.anything() }),
        expect.objectContaining({
          current_period_start: renewalAt,
          auto_top_up_triggered_for_period: null,
        }),
      ])
    );

    const saleCall = fetch.mock.calls
      .map(
        ([, init]) =>
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            action: string;
            input: Record<string, unknown>;
          }
      )
      .find(call => call.action === 'enqueue_affiliate_event');

    expect(saleCall).toEqual({
      action: 'enqueue_affiliate_event',
      input: {
        userId: 'user-1',
        provider: 'impact',
        eventType: 'sale',
        dedupeKey: 'affiliate:impact:sale:kiloclaw-subscription:instance-1:2026-04',
        eventDateIso: renewalAt,
        orderId: 'kiloclaw-subscription:instance-1:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
      },
    });
  });

  it('re-enqueues the existing sale dedupe key when the renewal deduction already committed', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, txInserts, txUpdates } = createMockDb(
      [
        [
          {
            user_id: 'user-1',
            email: 'user-1@example.com',
            instance_id: 'instance-1',
            id: 'sub-1',
            instance_row_id: 'instance-1',
            organization_id: null,
            instance_destroyed_at: null,
            plan: 'standard',
            status: 'active',
            credit_renewal_at: renewalAt,
            current_period_end: renewalAt,
            cancel_at_period_end: false,
            scheduled_plan: null,
            commit_ends_at: null,
            past_due_since: null,
            suspended_at: null,
            auto_resume_attempt_count: 0,
            auto_top_up_triggered_for_period: null,
            total_microdollars_acquired: 50_000_000,
            microdollars_used: 0,
            auto_top_up_enabled: false,
            kilo_pass_threshold: null,
            next_credit_expiration_at: null,
            user_updated_at: '2026-04-09T09:00:00.000Z',
          },
        ],
      ],
      { txInsertRowCounts: [0] }
    );
    mockGetWorkerDb.mockReturnValue(db);

    const fetch = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        action: string;
        input: Record<string, unknown>;
      };

      switch (body.action) {
        case 'project_pending_kilo_pass_bonus':
          return new Response(JSON.stringify({ projectedBonusMicrodollars: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        case 'enqueue_affiliate_event':
          return new Response(JSON.stringify({ enqueued: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        default:
          throw new Error(`Unexpected side effect action: ${body.action}`);
      }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(0);
    expect(summary.credit_renewals_skipped_duplicate).toBe(1);
    expect(summary.errors).toBe(0);
    expect(txInserts).toHaveLength(1);
    expect(txUpdates).toEqual([]);

    const sideEffectCalls = fetch.mock.calls.map(
      ([, init]) =>
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          action: string;
          input: Record<string, unknown>;
        }
    );

    expect(sideEffectCalls).toEqual([
      {
        action: 'project_pending_kilo_pass_bonus',
        input: {
          userId: 'user-1',
          microdollarsUsed: 9_000_000,
          kiloPassThreshold: null,
        },
      },
      {
        action: 'enqueue_affiliate_event',
        input: {
          userId: 'user-1',
          provider: 'impact',
          eventType: 'sale',
          dedupeKey: 'affiliate:impact:sale:kiloclaw-subscription:instance-1:2026-04',
          eventDateIso: renewalAt,
          orderId: 'kiloclaw-subscription:instance-1:2026-04',
          amount: 9,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard',
          itemName: 'KiloClaw Standard Plan',
          itemSku: 'price_standard',
        },
      },
    ]);
  });

  it('skips organization-managed rows in personal credit renewal sweep', async () => {
    const { db, txInserts, txUpdates } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          email: 'user-1@example.com',
          instance_id: 'instance-1',
          instance_row_id: 'instance-1',
          organization_id: 'org-1',
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'active',
          credit_renewal_at: '2026-04-09T10:00:00.000Z',
          current_period_end: '2026-04-09T10:00:00.000Z',
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 50_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: null,
          next_credit_expiration_at: null,
          user_updated_at: '2026-04-09T09:00:00.000Z',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '18181818-1818-4818-8818-181818181818',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(0);
    expect(summary.credit_renewals_skipped_duplicate).toBe(0);
    expect(summary.errors).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(txInserts).toHaveLength(0);
    expect(txUpdates).toHaveLength(0);
  });
});

describe('complementary inference ended sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ sent: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
  });

  it('sends complementary-ended email for normalized instance-ready log rows', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, inserts, selectBuilders } = createMockDb([
      [
        {
          user_id: 'user-1',
          email: 'user-1@example.com',
          instance_id: instanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '91919191-9191-4191-8191-919191919191',
        sweep: 'complementary_inference_ended',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.complementary_inference_ended_emails).toBe(1);
    expect(summary.emails_sent).toBe(1);
    expect(selectBuilders[0]?.innerJoin).toHaveBeenCalledTimes(2);
    expect(selectBuilders[0]?.leftJoin).not.toHaveBeenCalled();
    expect(inserts).toEqual([
      {
        user_id: 'user-1',
        instance_id: instanceId,
        email_type: 'claw_complementary_inference_ended',
      },
    ]);

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      action: string;
      input: Record<string, unknown>;
    };
    expect(body).toEqual({
      action: 'send_email',
      input: {
        to: 'user-1@example.com',
        templateName: 'clawComplementaryInferenceEnded',
        templateVars: { claw_url: 'https://app.kilo.ai/claw' },
        userId: 'user-1',
        instanceId,
      },
    });
  });

  it('suppresses duplicate complementary-ended email when log insert conflicts', async () => {
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const { db, inserts } = createMockDb(
      [
        [
          {
            user_id: 'user-2',
            email: 'user-2@example.com',
            instance_id: instanceId,
            sandbox_id: 'ki_22222222222242228222222222222222',
          },
        ],
      ],
      { insertRowCounts: [0] }
    );
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '92929292-9292-4292-8292-929292929292',
        sweep: 'complementary_inference_ended',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.complementary_inference_ended_emails).toBe(0);
    expect(summary.emails_sent).toBe(0);
    expect(summary.emails_skipped).toBe(1);
    expect(inserts).toEqual([
      {
        user_id: 'user-2',
        instance_id: instanceId,
        email_type: 'claw_complementary_inference_ended',
      },
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not send when purchased-credit exclusion returns no candidates', async () => {
    const { db, inserts } = createMockDb([[]]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '93939393-9393-4393-8393-939393939393',
        sweep: 'complementary_inference_ended',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.complementary_inference_ended_emails).toBe(0);
    expect(summary.emails_sent).toBe(0);
    expect(inserts).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not send when destroyed-instance exclusion returns no candidates', async () => {
    const { db, inserts } = createMockDb([[]]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '94949494-9494-4494-8494-949494949494',
        sweep: 'complementary_inference_ended',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.complementary_inference_ended_emails).toBe(0);
    expect(summary.emails_sent).toBe(0);
    expect(inserts).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('soft-deleted user lifecycle exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('skips subscription expiry processing for soft-deleted users', async () => {
    const { db, updates, inserts } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: '11111111-1111-4111-8111-111111111111',
          sandbox_id: 'ki_11111111111141118111111111111111',
          email: 'deleted+user-1@deleted.invalid',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: '34343434-3434-4434-8434-343434343434',
        sweep: 'subscription_expiry',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.sweep2_subscription_expiry).toBe(0);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips earlybird warnings for soft-deleted users', async () => {
    const { db, inserts } = createMockDb([
      [{ user_id: 'user-1', email: 'deleted+user-1@deleted.invalid' }],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: '56565656-5656-4656-8656-565656565656',
        sweep: 'earlybird_warning',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.earlybird_warnings).toBe(0);
    expect(inserts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
