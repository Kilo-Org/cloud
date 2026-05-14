import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkerDb, mockGetMissingSnowflakeConfig, mockQueryKiloclawActiveUserIds } =
  vi.hoisted(() => ({
    mockGetWorkerDb: vi.fn(),
    mockGetMissingSnowflakeConfig: vi.fn<() => string[]>(() => []),
    mockQueryKiloclawActiveUserIds: vi.fn(),
  }));

vi.mock('@kilocode/db', async importOriginal => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    getWorkerDb: mockGetWorkerDb,
  };
});

vi.mock('./snowflake.js', () => ({
  getMissingSnowflakeConfig: mockGetMissingSnowflakeConfig,
  queryKiloclawActiveUserIds: mockQueryKiloclawActiveUserIds,
}));

import { processTrialInactivityStopCandidate, runSweep } from './lifecycle.js';
import type { BillingWorkerEnv } from './types.js';

let loggedValues: unknown[] = [];

type SelectBuilder = {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  then: Promise<unknown[]>['then'];
};

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
  const nextSelectRows = () => selectResults.shift() ?? [];
  const createWhereResult = (returningRows: unknown[]) => {
    const promise = Promise.resolve(undefined);
    return {
      returning: vi.fn(async () => returningRows),
      then: promise.then.bind(promise),
    };
  };
  const createSelectBuilder = (): SelectBuilder => {
    const rows = nextSelectRows();
    const promise = Promise.resolve(rows);
    const builder: SelectBuilder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => rows),
      then: promise.then.bind(promise),
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
        select: ReturnType<typeof vi.fn>;
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
        select: vi.fn(() => createSelectBuilder()),
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
  return createEnvWithQueueMocks(fetchImpl).env;
}

function createEnvWithQueueMocks(fetchImpl: BillingWorkerEnv['KILOCLAW']['fetch']): {
  env: BillingWorkerEnv;
  trialInactivitySendBatch: ReturnType<typeof vi.fn>;
} {
  const trialInactivitySendBatch = vi.fn();

  return {
    env: {
      HYPERDRIVE: { connectionString: 'postgres://test' },
      LIFECYCLE_QUEUE: {
        send: vi.fn(),
      } as never,
      TRIAL_INACTIVITY_QUEUE: {
        send: vi.fn(),
        sendBatch: trialInactivitySendBatch,
      } as never,
      KILOCLAW: {
        fetch: fetchImpl,
      },
      KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
      STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID: 'price_legacy_standard_intro',
      STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID: 'price_legacy_standard',
      STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID: 'price_legacy_commit',
      STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID: 'price_current_standard',
      STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID: 'price_current_commit',
      INTERNAL_API_SECRET: 'next-internal-api-secret',
      KILOCLAW_INTERNAL_API_SECRET: 'claw-secret',
      TRIAL_INACTIVITY_STOP_ENABLED: 'true',
      TRIAL_INACTIVITY_STOP_DRY_RUN: 'false',
      SNOWFLAKE_ACCOUNT_HOST: 'fyc17898.us-east-1',
      SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER: 'FYC17898',
      SNOWFLAKE_USERNAME: 'KILOCODE_USER',
      SNOWFLAKE_ROLE: 'KILOCODE_ROLE',
      SNOWFLAKE_WAREHOUSE: 'WH_KILOCODE',
      SNOWFLAKE_DATABASE: 'KILO_DW',
      SNOWFLAKE_SCHEMA: 'DBT_PROD',
      SNOWFLAKE_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      SNOWFLAKE_PUBLIC_KEY_FINGERPRINT: 'SHA256:test',
    },
    trialInactivitySendBatch,
  };
}

describe('interrupted auto-resume sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('requests async start and records retry metadata on acceptance', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    const { db, updates } = createMockDb([
      [
        {
          user_id: 'user-1',
          instance_id: instanceId,
          suspended_at: null,
          auto_resume_requested_at: '2026-04-21T10:00:00.000Z',
          auto_resume_retry_after: '2026-04-21T12:00:00.000Z',
          auto_resume_attempt_count: 0,
        },
      ],
      [{ id: instanceId, sandbox_id: sandboxId }],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toContain(`/api/platform/start-async?instanceId=${instanceId}`);
      if (request instanceof Request) {
        await expect(request.json()).resolves.toEqual({
          userId: 'user-1',
          reason: 'interrupted_auto_resume',
        });
      }
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

  it('keeps retry metadata when async resume request fails', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    const { db, updates } = createMockDb([
      [
        {
          user_id: 'user-1',
          instance_id: instanceId,
          suspended_at: null,
          auto_resume_requested_at: '2026-04-21T10:00:00.000Z',
          auto_resume_retry_after: '2026-04-21T12:00:00.000Z',
          auto_resume_attempt_count: 1,
        },
      ],
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

  it('keeps retry metadata after 404 from async resume request', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const sandboxId = 'ki_11111111111141118111111111111111';
    const { db, updates } = createMockDb([
      [
        {
          user_id: 'user-1',
          instance_id: instanceId,
          suspended_at: null,
          auto_resume_requested_at: '2026-04-21T10:00:00.000Z',
          auto_resume_retry_after: '2026-04-21T12:00:00.000Z',
          auto_resume_attempt_count: 0,
        },
      ],
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

  it('clears stale resume state when no active instance remains', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, updates, txUpdates, txDeletes } = createMockDb([
      [
        {
          user_id: 'user-1',
          instance_id: instanceId,
          suspended_at: null,
          auto_resume_requested_at: '2026-04-21T10:00:00.000Z',
          auto_resume_retry_after: '2026-04-21T12:00:00.000Z',
          auto_resume_attempt_count: 1,
        },
      ],
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
          suspended_at: null,
          auto_resume_requested_at: '2026-04-21T10:00:00.000Z',
          auto_resume_retry_after: '2026-04-21T12:00:00.000Z',
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

describe('trial expiry sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
  });

  it('clears the inactivity marker when an expired trial leaves trialing state', async () => {
    const instanceId = '21212121-2121-4212-8212-212121212121';
    const { db, updates } = createMockDb([
      [
        {
          id: 'sub-trial-expired',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_21212121212142128212212121212121',
          instance_destroyed_at: null,
          organization_id: null,
          email: 'user-1@example.com',
          trial_ends_at: '2026-04-17T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'sub-trial-expired',
          user_id: 'user-1',
          instance_id: instanceId,
          plan: 'trial',
          status: 'trialing',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      if (!url.includes('/api/platform/stop')) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          stopped: true,
          previousStatus: 'running',
          currentStatus: 'stopped',
          stoppedAt: Date.parse('2026-04-22T00:00:00.000Z'),
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    });

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: '21212121-2121-4212-8212-212121212120',
        sweep: 'trial_expiry',
      },
      1
    );

    expect(summary.sweep1_trial_expiry).toBe(1);
    expect(summary.errors).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const stopRequest = fetch.mock.calls[0]?.[0];
    expect(stopRequest).toBeInstanceOf(Request);
    if (!(stopRequest instanceof Request)) {
      throw new Error('expected Request');
    }
    expect(await stopRequest.json()).toEqual({
      userId: 'user-1',
      reason: 'trial_expiry',
    });
    const cancellationUpdate = updates.find(
      update =>
        update.status === 'canceled' &&
        typeof update.suspended_at === 'string' &&
        typeof update.destruction_deadline === 'string'
    );
    expect(cancellationUpdate).toBeDefined();
    expect(updates).toContainEqual({ inactive_trial_stopped_at: null });
  });

  it('does not expire a legacy trial before its recorded trial end timestamp', async () => {
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const { db, updates, inserts } = createMockDb([
      [
        {
          id: 'sub-legacy-active-trial',
          user_id: 'user-legacy-active',
          instance_id: instanceId,
          sandbox_id: 'ki_22222222222242228222222222222222',
          instance_destroyed_at: null,
          organization_id: null,
          email: 'legacy-active@example.com',
          trial_ends_at: '2099-04-17T00:00:00.000Z',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: '22222222-2222-4222-8222-222222222220',
        sweep: 'trial_expiry',
      },
      1
    );

    expect(summary.sweep1_trial_expiry).toBe(0);
    expect(summary.errors).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
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

describe('trial warning sweep', () => {
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

  it('does not send the 2-day warning for current-price one-day trials', async () => {
    const instanceId = '44444444-4444-4444-8444-444444444444';
    const { db, inserts } = createMockDb([
      [
        {
          id: 'sub-current-one-day',
          user_id: 'user-current',
          instance_id: instanceId,
          instance_destroyed_at: null,
          instance_sandbox_id: 'ki_44444444444444448444444444444444',
          organization_id: null,
          email: 'current@example.com',
          trial_ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          kiloclaw_price_version: '2026-05-10',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '44444444-4444-4444-8444-444444444440',
        sweep: 'trial_warning',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.trial_warnings).toBe(0);
    expect(summary.emails_sent).toBe(0);
    expect(inserts).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('sends the 2-day warning for legacy seven-day trials', async () => {
    const instanceId = '45454545-4545-4545-8545-454545454545';
    const { db, inserts } = createMockDb([
      [
        {
          id: 'sub-legacy-seven-day',
          user_id: 'user-legacy',
          instance_id: instanceId,
          instance_destroyed_at: null,
          instance_sandbox_id: 'ki_45454545454545458545454545454545',
          organization_id: null,
          email: 'legacy@example.com',
          trial_ends_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          kiloclaw_price_version: '2026-03-19',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '45454545-4545-4545-8545-454545454540',
        sweep: 'trial_warning',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.trial_warnings).toBe(1);
    expect(summary.emails_sent).toBe(1);
    expect(inserts).toEqual([
      {
        user_id: 'user-legacy',
        instance_id: instanceId,
        email_type: 'claw_trial_5d',
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
        to: 'legacy@example.com',
        templateName: 'clawTrialEndingSoon',
        templateVars: { days_remaining: '2', claw_url: 'https://app.kilo.ai/claw' },
        subjectOverride: 'Your KiloClaw Trial Ends in 2 Days',
        userId: 'user-legacy',
        instanceId,
      },
    });
  });

  it('sends only the urgent warning for current one-day trials', async () => {
    const instanceId = '46464646-4646-4646-8646-464646464646';
    const { db, inserts } = createMockDb([
      [
        {
          id: 'sub-current-urgent',
          user_id: 'user-current-urgent',
          instance_id: instanceId,
          instance_destroyed_at: null,
          instance_sandbox_id: 'ki_46464646464646468646464646464646',
          organization_id: null,
          email: 'urgent@example.com',
          trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
          kiloclaw_price_version: '2026-05-10',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '46464646-4646-4646-8646-464646464640',
        sweep: 'trial_warning',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.trial_warnings).toBe(1);
    expect(summary.emails_sent).toBe(1);
    expect(inserts).toEqual([
      {
        user_id: 'user-current-urgent',
        instance_id: instanceId,
        email_type: 'claw_trial_1d',
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
        to: 'urgent@example.com',
        templateName: 'clawTrialExpiresTomorrow',
        templateVars: { claw_url: 'https://app.kilo.ai/claw' },
        userId: 'user-current-urgent',
        instanceId,
      },
    });
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

  it('does not destroy active subscriptions even with stale expired destruction fields', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, updates, txUpdates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-active',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
          organization_id: null,
          status: 'active',
          email: 'user-1@example.com',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: 'abababab-abab-4bab-8bab-abababababab',
        sweep: 'instance_destruction',
      },
      1
    );

    expect(summary.errors).toBe(0);
    expect(summary.sweep3_instance_destruction).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(txUpdates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(loggedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Skipping instance destruction for active subscription row',
          reason: 'active_subscription',
        }),
      ])
    );
  });

  it('keeps DB/email cleanup unchanged when platform destroy succeeds', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, updates, txUpdates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
          status: 'canceled',
          email: 'user-1@example.com',
        },
      ],
      [
        {
          id: instanceId,
          userId: 'user-1',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
          name: null,
          inboundEmailEnabled: false,
          destroyedAt: null,
        },
      ],
      [],
      [{ id: 'sub-1', user_id: 'user-1', instance_id: instanceId }],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      if (request instanceof Request) {
        await expect(request.json()).resolves.toEqual({
          userId: 'user-1',
          reason: 'destruction_deadline_elapsed',
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

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
    expect(txUpdates).toHaveLength(1);
    expect(txUpdates[0]?.destroyed_at).toEqual(expect.any(String));
    expect(updates).toEqual([{ destruction_deadline: null }]);
    expect(deletes).toHaveLength(1);
  });

  it('treats platform destroy 404 as already gone and continues with later rows', async () => {
    const firstInstanceId = '11111111-1111-4111-8111-111111111111';
    const secondInstanceId = '22222222-2222-4222-8222-222222222222';
    const { db, updates, txUpdates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: firstInstanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
          status: 'canceled',
          email: 'user-1@example.com',
        },
        {
          id: 'sub-2',
          user_id: 'user-2',
          instance_id: secondInstanceId,
          sandbox_id: 'ki_22222222222242228222222222222222',
          status: 'canceled',
          email: 'user-2@example.com',
        },
      ],
      [
        {
          id: firstInstanceId,
          userId: 'user-1',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
          name: null,
          inboundEmailEnabled: false,
          destroyedAt: null,
        },
      ],
      [],
      [{ id: 'sub-1', user_id: 'user-1', instance_id: firstInstanceId }],
      [
        {
          id: secondInstanceId,
          userId: 'user-2',
          sandboxId: 'ki_22222222222242228222222222222222',
          organizationId: null,
          name: null,
          inboundEmailEnabled: false,
          destroyedAt: null,
        },
      ],
      [],
      [{ id: 'sub-2', user_id: 'user-2', instance_id: secondInstanceId }],
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
    expect(txUpdates).toHaveLength(2);
    expect(txUpdates[0]?.destroyed_at).toEqual(expect.any(String));
    expect(txUpdates[1]?.destroyed_at).toEqual(expect.any(String));
    expect(updates).toEqual([{ destruction_deadline: null }, { destruction_deadline: null }]);
    expect(deletes).toHaveLength(2);
  });

  it('logs non-404 platform destroy failures and preserves billing state transition', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const { db, updates, txUpdates, inserts, deletes } = createMockDb([
      [
        {
          id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_11111111111141118111111111111111',
          status: 'canceled',
          email: 'user-1@example.com',
        },
      ],
      [
        {
          id: instanceId,
          userId: 'user-1',
          sandboxId: 'ki_11111111111141118111111111111111',
          organizationId: null,
          name: null,
          inboundEmailEnabled: false,
          destroyedAt: null,
        },
      ],
      [],
      [{ id: 'sub-1', user_id: 'user-1', instance_id: instanceId }],
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
    expect(txUpdates).toHaveLength(1);
    expect(txUpdates[0]?.destroyed_at).toEqual(expect.any(String));
    expect(updates).toEqual([{ destruction_deadline: null }]);
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
          status: 'canceled',
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

  it('charges pure-credit renewals from the subscription price version catalog', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, txInserts } = createMockDb([
      [
        {
          user_id: 'legacy-user',
          email: 'legacy-user@example.com',
          instance_id: 'legacy-instance',
          id: 'legacy-sub',
          instance_row_id: 'legacy-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'active',
          kiloclaw_price_version: '2026-03-19',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 100_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: null,
          next_credit_expiration_at: null,
          user_updated_at: '2026-04-09T09:00:00.000Z',
        },
        {
          user_id: 'current-user',
          email: 'current-user@example.com',
          instance_id: 'current-instance',
          id: 'current-sub',
          instance_row_id: 'current-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'active',
          kiloclaw_price_version: '2026-05-10',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 100_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: null,
          next_credit_expiration_at: null,
          user_updated_at: '2026-04-09T09:00:00.000Z',
        },
        {
          user_id: 'current-commit-user',
          email: 'current-commit-user@example.com',
          instance_id: 'current-commit-instance',
          id: 'current-commit-sub',
          instance_row_id: 'current-commit-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'commit',
          status: 'active',
          kiloclaw_price_version: '2026-05-10',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: renewalAt,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 400_000_000,
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
        case 'process_paid_conversion':
          return new Response(
            JSON.stringify({
              affiliateSaleEnqueued: true,
              winningTouchType: 'affiliate',
              conversionId: null,
              disqualificationReason: null,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        default:
          throw new Error(`Unexpected side effect action: ${body.action}`);
      }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(3);
    expect(summary.errors).toBe(0);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kilo_user_id: 'legacy-user',
          amount_microdollars: -9_000_000,
          credit_category: 'kiloclaw-subscription:legacy-instance:2026-04',
        }),
        expect.objectContaining({
          kilo_user_id: 'current-user',
          amount_microdollars: -55_000_000,
          credit_category: 'kiloclaw-subscription:current-instance:2026-04',
        }),
        expect.objectContaining({
          kilo_user_id: 'current-commit-user',
          amount_microdollars: -306_000_000,
          credit_category: 'kiloclaw-subscription-commit:current-commit-instance:2026-04',
        }),
      ])
    );

    const paidConversionCalls = fetch.mock.calls
      .map(
        ([, init]) =>
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            action: string;
            input: Record<string, unknown>;
          }
      )
      .filter(call => call.action === 'process_paid_conversion');
    const paidConversionInputs = paidConversionCalls.map(call => call.input);
    expect(paidConversionInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'legacy-user',
          amount: 9,
          itemCategory: 'kiloclaw-standard-2026-03-19',
          itemName: 'KiloClaw Standard Plan',
          itemSku: 'kiloclaw-standard-2026-03-19',
        }),
        expect.objectContaining({
          userId: 'current-user',
          amount: 55,
          itemCategory: 'kiloclaw-standard-2026-05-10',
          itemName: 'KiloClaw Standard Plan',
          itemSku: 'kiloclaw-standard-2026-05-10',
        }),
        expect.objectContaining({
          userId: 'current-commit-user',
          amount: 306,
          itemCategory: 'kiloclaw-commit-2026-05-10',
          itemName: 'KiloClaw Commit Plan',
          itemSku: 'kiloclaw-commit-2026-05-10',
        }),
      ])
    );
  });

  it('skips hybrid rows in the credit renewal sweep', async () => {
    const { db, txInserts, txUpdates } = createMockDb([
      [
        {
          user_id: 'hybrid-user',
          email: 'hybrid-user@example.com',
          instance_id: 'hybrid-instance',
          id: 'hybrid-sub',
          instance_row_id: 'hybrid-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'active',
          kiloclaw_price_version: '2026-05-10',
          stripe_subscription_id: 'stripe-subscription',
          credit_renewal_at: '2026-04-09T10:00:00.000Z',
          current_period_end: '2026-04-09T10:00:00.000Z',
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 100_000_000,
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
        runId: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
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

  it('applies scheduled pure-credit plan switches atomically at the versioned renewal cost', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, updates, txInserts, txUpdates } = createMockDb([
      [
        {
          user_id: 'switch-user',
          email: 'switch-user@example.com',
          instance_id: 'switch-instance',
          id: 'switch-sub',
          instance_row_id: 'switch-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'active',
          kiloclaw_price_version: '2026-05-10',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: 'commit',
          commit_ends_at: null,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 400_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: null,
          next_credit_expiration_at: null,
          user_updated_at: '2026-04-09T09:00:00.000Z',
        },
        {
          user_id: 'legacy-switch-user',
          email: 'legacy-switch-user@example.com',
          instance_id: 'legacy-switch-instance',
          id: 'legacy-switch-sub',
          instance_row_id: 'legacy-switch-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'commit',
          status: 'active',
          kiloclaw_price_version: '2026-03-19',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: 'standard',
          commit_ends_at: renewalAt,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 100_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: null,
          next_credit_expiration_at: null,
          user_updated_at: '2026-04-09T09:00:00.000Z',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          action: string;
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
          case 'process_paid_conversion':
            return new Response(
              JSON.stringify({
                affiliateSaleEnqueued: true,
                winningTouchType: 'affiliate',
                conversionId: null,
                disqualificationReason: null,
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }
            );
          default:
            throw new Error(`Unexpected side effect action: ${body.action}`);
        }
      })
    );

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(2);
    expect(summary.errors).toBe(0);
    expect(updates).toHaveLength(0);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kilo_user_id: 'switch-user',
          amount_microdollars: -306_000_000,
          credit_category: 'kiloclaw-subscription-commit:switch-instance:2026-04',
        }),
        expect.objectContaining({
          subscription_id: 'switch-sub',
          action: 'plan_switched',
          reason: 'credit_renewal_plan_switch',
        }),
        expect.objectContaining({
          kilo_user_id: 'legacy-switch-user',
          amount_microdollars: -9_000_000,
          credit_category: 'kiloclaw-subscription:legacy-switch-instance:2026-04',
        }),
        expect.objectContaining({
          subscription_id: 'legacy-switch-sub',
          action: 'plan_switched',
          reason: 'credit_renewal_plan_switch',
        }),
      ])
    );
    expect(txUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          current_period_start: renewalAt,
          current_period_end: '2026-10-09T10:00:00.000Z',
          credit_renewal_at: '2026-10-09T10:00:00.000Z',
          plan: 'commit',
          scheduled_plan: null,
          scheduled_by: null,
          commit_ends_at: '2026-10-09T10:00:00.000Z',
        }),
        expect.objectContaining({
          current_period_start: renewalAt,
          current_period_end: '2026-05-09T10:00:00.000Z',
          credit_renewal_at: '2026-05-09T10:00:00.000Z',
          plan: 'standard',
          scheduled_plan: null,
          scheduled_by: null,
          commit_ends_at: null,
        }),
      ])
    );
    for (const update of txUpdates) {
      expect(update).not.toHaveProperty('kiloclaw_price_version');
    }
  });

  it('cancels pending pure-credit rows without charging, advancing, or rewriting price version', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, inserts, updates, txInserts, txUpdates } = createMockDb(
      [
        [
          {
            user_id: 'cancel-user',
            email: 'cancel-user@example.com',
            instance_id: 'cancel-instance',
            id: 'cancel-sub',
            instance_row_id: 'cancel-instance',
            organization_id: null,
            instance_destroyed_at: null,
            plan: 'standard',
            status: 'active',
            kiloclaw_price_version: '2026-05-10',
            credit_renewal_at: renewalAt,
            current_period_end: renewalAt,
            cancel_at_period_end: true,
            scheduled_plan: null,
            commit_ends_at: null,
            past_due_since: null,
            suspended_at: null,
            auto_resume_attempt_count: 0,
            auto_top_up_triggered_for_period: null,
            total_microdollars_acquired: 100_000_000,
            microdollars_used: 0,
            auto_top_up_enabled: false,
            kilo_pass_threshold: null,
            next_credit_expiration_at: null,
            user_updated_at: '2026-04-09T09:00:00.000Z',
          },
        ],
      ],
      {
        updateReturningRows: [
          [
            {
              id: 'cancel-sub',
              status: 'canceled',
              cancel_at_period_end: false,
              kiloclaw_price_version: '2026-05-10',
              current_period_end: renewalAt,
              credit_renewal_at: renewalAt,
            },
          ],
        ],
      }
    );
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals_canceled).toBe(1);
    expect(summary.credit_renewals).toBe(0);
    expect(summary.errors).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(txInserts).toHaveLength(0);
    expect(txUpdates).toHaveLength(0);
    expect(updates).toEqual([
      {
        status: 'canceled',
        cancel_at_period_end: false,
        auto_top_up_triggered_for_period: null,
      },
    ]);
    expect(updates[0]).not.toHaveProperty('kiloclaw_price_version');
    expect(updates[0]).not.toHaveProperty('current_period_start');
    expect(updates[0]).not.toHaveProperty('current_period_end');
    expect(updates[0]).not.toHaveProperty('credit_renewal_at');
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subscription_id: 'cancel-sub',
          action: 'canceled',
          reason: 'credit_renewal_cancel_at_period_end',
        }),
      ])
    );
  });

  it('recovers past-due pure-credit renewals at the versioned cost and clears retry email state', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, deletes, txInserts, txUpdates } = createMockDb([
      [
        {
          user_id: 'past-due-user',
          email: 'past-due-user@example.com',
          instance_id: 'past-due-instance',
          id: 'past-due-sub',
          instance_row_id: 'past-due-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'past_due',
          kiloclaw_price_version: '2026-05-10',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: '2026-04-08T10:00:00.000Z',
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 100_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: 55_000_000,
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
        case 'process_paid_conversion':
          return new Response(
            JSON.stringify({
              affiliateSaleEnqueued: true,
              winningTouchType: 'affiliate',
              conversionId: null,
              disqualificationReason: null,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        default:
          throw new Error(`Unexpected side effect action: ${body.action}`);
      }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(1);
    expect(summary.errors).toBe(0);
    expect(deletes).toHaveLength(1);
    expect(txInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kilo_user_id: 'past-due-user',
          amount_microdollars: -55_000_000,
        }),
        expect.objectContaining({
          subscription_id: 'past-due-sub',
          action: 'reactivated',
          reason: 'credit_renewal_reactivated',
        }),
      ])
    );
    expect(txUpdates.some(update => 'microdollars_used' in update)).toBe(true);
    expect(txUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'active',
          past_due_since: null,
          credit_renewal_at: '2026-05-09T10:00:00.000Z',
        }),
      ])
    );

    const sideEffectCalls = fetch.mock.calls.map(
      ([, init]) =>
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          action: string;
          input: Record<string, unknown>;
        }
    );
    expect(sideEffectCalls).toEqual(
      expect.arrayContaining([
        {
          action: 'project_pending_kilo_pass_bonus',
          input: {
            userId: 'past-due-user',
            microdollarsUsed: 55_000_000,
            kiloPassThreshold: 55_000_000,
          },
        },
      ])
    );
    const bonusCall = sideEffectCalls.find(
      call => call.action === 'issue_kilo_pass_bonus_from_usage_threshold'
    );
    expect(bonusCall?.input.userId).toBe('past-due-user');
    expect(typeof bonusCall?.input.nowIso).toBe('string');
  });

  it('sends insufficient-credit email without charging when balance and auto top-up are unavailable', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, inserts, updates, txInserts } = createMockDb([
      [
        {
          user_id: 'insufficient-user',
          email: 'insufficient-user@example.com',
          instance_id: 'insufficient-instance',
          id: 'insufficient-sub',
          instance_row_id: 'insufficient-instance',
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'active',
          kiloclaw_price_version: '2026-05-10',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: null,
          suspended_at: null,
          auto_resume_attempt_count: 0,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 1_000_000,
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
        case 'send_email':
          return new Response(JSON.stringify({ sent: true }), {
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
        runId: 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals_past_due).toBe(1);
    expect(summary.emails_sent).toBe(1);
    expect(summary.credit_renewals).toBe(0);
    expect(summary.errors).toBe(0);
    expect(txInserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: 'past_due' });
    expect(updates[0]).toHaveProperty('past_due_since');
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subscription_id: 'insufficient-sub',
          action: 'status_changed',
          reason: 'credit_renewal_insufficient_credits',
        }),
        expect.objectContaining({
          email_type: 'claw_credit_renewal_failed',
          user_id: 'insufficient-user',
          instance_id: 'insufficient-instance',
        }),
      ])
    );

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
          userId: 'insufficient-user',
          microdollarsUsed: 55_000_000,
          kiloPassThreshold: null,
        },
      },
      {
        action: 'send_email',
        input: {
          to: 'insufficient-user@example.com',
          templateName: 'clawCreditRenewalFailed',
          templateVars: { claw_url: 'https://app.kilo.ai/claw' },
          userId: 'insufficient-user',
          instanceId: 'insufficient-instance',
        },
      },
    ]);
  });

  it('requests auto-resume when suspended past-due rows recover through credit renewal', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const instanceId = '77777777-7777-4777-8777-777777777777';
    const { db, updates, txUpdates } = createMockDb([
      [
        {
          user_id: 'suspended-user',
          email: 'suspended-user@example.com',
          instance_id: instanceId,
          id: 'suspended-sub',
          instance_row_id: instanceId,
          organization_id: null,
          instance_destroyed_at: null,
          plan: 'standard',
          status: 'past_due',
          kiloclaw_price_version: '2026-05-10',
          credit_renewal_at: renewalAt,
          current_period_end: renewalAt,
          cancel_at_period_end: false,
          scheduled_plan: null,
          commit_ends_at: null,
          past_due_since: '2026-03-20T10:00:00.000Z',
          suspended_at: '2026-04-08T10:00:00.000Z',
          auto_resume_attempt_count: 2,
          auto_top_up_triggered_for_period: null,
          total_microdollars_acquired: 100_000_000,
          microdollars_used: 0,
          auto_top_up_enabled: false,
          kilo_pass_threshold: null,
          next_credit_expiration_at: null,
          user_updated_at: '2026-04-09T09:00:00.000Z',
        },
      ],
      [],
      [{ id: instanceId, sandbox_id: 'ki_77777777777747778777777777777777' }],
    ]);
    mockGetWorkerDb.mockReturnValue(db);

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          action: string;
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
          case 'process_paid_conversion':
            return new Response(
              JSON.stringify({
                affiliateSaleEnqueued: true,
                winningTouchType: 'affiliate',
                conversionId: null,
                disqualificationReason: null,
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }
            );
          default:
            throw new Error(`Unexpected side effect action: ${body.action}`);
        }
      })
    );
    const kiloclawFetch = vi.fn(async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toContain(`/api/platform/start-async?instanceId=${instanceId}`);
      if (request instanceof Request) {
        await expect(request.json()).resolves.toEqual({
          userId: 'suspended-user',
          reason: 'interrupted_auto_resume',
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const summary = await runSweep(
      createEnv(kiloclawFetch),
      {
        runId: '17171717-1717-4717-8717-171717171717',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(1);
    expect(summary.errors).toBe(0);
    expect(kiloclawFetch).toHaveBeenCalledTimes(1);
    expect(txUpdates).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'active', past_due_since: null })])
    );
    const autoResumeUpdate = updates.find(update => update.auto_resume_attempt_count === 3);
    expect(autoResumeUpdate).toMatchObject({ auto_resume_attempt_count: 3 });
    expect(typeof autoResumeUpdate?.auto_resume_requested_at).toBe('string');
    expect(typeof autoResumeUpdate?.auto_resume_retry_after).toBe('string');
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
          kiloclaw_price_version: '2026-03-19',
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
        case 'process_paid_conversion':
          return new Response(
            JSON.stringify({
              affiliateSaleEnqueued: true,
              winningTouchType: 'affiliate',
              conversionId: null,
              disqualificationReason: null,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
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
      .find(call => call.action === 'process_paid_conversion');

    expect(saleCall).toEqual({
      action: 'process_paid_conversion',
      input: {
        userId: 'user-1',
        dedupeKey: 'affiliate:impact:sale:kiloclaw-subscription:instance-1:2026-04',
        eventDateIso: renewalAt,
        orderId: 'kiloclaw-subscription:instance-1:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard-2026-03-19',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'kiloclaw-standard-2026-03-19',
      },
    });
  });

  it('does not roll back or fail renewal when paid conversion side effect fails', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const { db, txUpdates } = createMockDb([
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
          kiloclaw_price_version: '2026-03-19',
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

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          action: string;
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
          case 'process_paid_conversion':
            return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          default:
            throw new Error(`Unexpected side effect action: ${body.action}`);
        }
      })
    );

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals).toBe(1);
    expect(summary.errors).toBe(0);
    expect(txUpdates).toEqual(
      expect.arrayContaining([expect.objectContaining({ current_period_start: renewalAt })])
    );
    expect(txUpdates.some(update => 'microdollars_used' in update)).toBe(true);
    expect(txUpdates).not.toContainEqual(expect.objectContaining({ credit_renewal_at: renewalAt }));
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
            kiloclaw_price_version: '2026-03-19',
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
        case 'process_paid_conversion':
          return new Response(
            JSON.stringify({
              affiliateSaleEnqueued: true,
              winningTouchType: 'affiliate',
              conversionId: null,
              disqualificationReason: null,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
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
        action: 'process_paid_conversion',
        input: {
          userId: 'user-1',
          dedupeKey: 'affiliate:impact:sale:kiloclaw-subscription:instance-1:2026-04',
          eventDateIso: renewalAt,
          orderId: 'kiloclaw-subscription:instance-1:2026-04',
          amount: 9,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard-2026-03-19',
          itemName: 'KiloClaw Standard Plan',
          itemSku: 'kiloclaw-standard-2026-03-19',
        },
      },
    ]);
  });

  it('marks auto-top-up-triggered period and writes changelog before triggering top-up', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const beforeRow = {
      id: 'sub-1',
      user_id: 'user-1',
      email: 'user-1@example.com',
      instance_id: 'instance-1',
      instance_row_id: 'instance-1',
      organization_id: null,
      instance_destroyed_at: null,
      plan: 'standard',
      status: 'active',
      kiloclaw_price_version: '2026-03-19',
      credit_renewal_at: renewalAt,
      current_period_end: renewalAt,
      cancel_at_period_end: false,
      scheduled_plan: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      total_microdollars_acquired: 1_000_000,
      microdollars_used: 900_000,
      auto_top_up_enabled: true,
      kilo_pass_threshold: null,
      next_credit_expiration_at: null,
      user_updated_at: '2026-04-09T09:00:00.000Z',
    };
    const afterRow = {
      ...beforeRow,
      auto_top_up_triggered_for_period: renewalAt,
    };
    const { db, inserts, updates } = createMockDb([[beforeRow]], {
      updateReturningRows: [[afterRow]],
    });
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
        case 'trigger_user_auto_top_up':
          return new Response(JSON.stringify({ ok: true }), {
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
        runId: 'dadadada-dada-4ada-8ada-dadadadadada',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals_auto_top_up).toBe(1);
    expect(summary.credit_renewals).toBe(0);
    expect(summary.errors).toBe(0);
    expect(updates).toEqual([{ auto_top_up_triggered_for_period: renewalAt }]);
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_id: 'billing-lifecycle-job',
          action: 'status_changed',
          reason: 'credit_renewal_auto_top_up_marked',
        }),
      ])
    );

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
          microdollarsUsed: 9_900_000,
          kiloPassThreshold: null,
        },
      },
      {
        action: 'trigger_user_auto_top_up',
        input: {
          user: {
            id: 'user-1',
            total_microdollars_acquired: 1_000_000,
            microdollars_used: 900_000,
            auto_top_up_enabled: true,
            next_credit_expiration_at: null,
            updated_at: '2026-04-09T09:00:00.000Z',
          },
        },
      },
    ]);
  });

  it('skips auto-top-up trigger when marker update loses concurrent race', async () => {
    const renewalAt = '2026-04-09T10:00:00.000Z';
    const beforeRow = {
      id: 'sub-1',
      user_id: 'user-1',
      email: 'user-1@example.com',
      instance_id: 'instance-1',
      instance_row_id: 'instance-1',
      organization_id: null,
      instance_destroyed_at: null,
      plan: 'standard',
      status: 'active',
      kiloclaw_price_version: '2026-03-19',
      credit_renewal_at: renewalAt,
      current_period_end: renewalAt,
      cancel_at_period_end: false,
      scheduled_plan: null,
      commit_ends_at: null,
      past_due_since: null,
      suspended_at: null,
      auto_resume_attempt_count: 0,
      auto_top_up_triggered_for_period: null,
      total_microdollars_acquired: 1_000_000,
      microdollars_used: 900_000,
      auto_top_up_enabled: true,
      kilo_pass_threshold: null,
      next_credit_expiration_at: null,
      user_updated_at: '2026-04-09T09:00:00.000Z',
    };
    const { db, inserts, updates } = createMockDb([[beforeRow]], {
      updateReturningRows: [[]],
    });
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
        case 'trigger_user_auto_top_up':
          throw new Error('trigger_user_auto_top_up should not run after lost marker race');
        default:
          throw new Error(`Unexpected side effect action: ${body.action}`);
      }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: 'dededede-dede-4ede-8ede-dededededede',
        sweep: 'credit_renewal',
      },
      1
    );

    expect(summary.credit_renewals_auto_top_up).toBe(0);
    expect(summary.credit_renewals).toBe(0);
    expect(summary.errors).toBe(0);
    expect(updates).toEqual([{ auto_top_up_triggered_for_period: renewalAt }]);
    expect(inserts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'credit_renewal_auto_top_up_marked',
        }),
      ])
    );

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
          microdollarsUsed: 9_900_000,
          kiloPassThreshold: null,
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
          kiloclaw_price_version: '2026-03-19',
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

describe('trial inactivity stop sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkerDb.mockReset();
    mockGetMissingSnowflakeConfig.mockReset();
    mockGetMissingSnowflakeConfig.mockReturnValue([]);
    mockQueryKiloclawActiveUserIds.mockReset();
    loggedValues = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      loggedValues.push(value);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('does not enqueue stop-candidate work for current one-day trial instances', async () => {
    const instanceId = '76767676-7676-4676-8676-767676767676';
    const { db } = createMockDb([
      [
        {
          subscription_id: 'sub-current-one-day-inactivity',
          user_id: 'user-current-one-day-inactivity',
          instance_id: instanceId,
          sandbox_id: 'ki_76767676767646768676767676767676',
          organization_id: null,
          instance_destroyed_at: null,
          instance_created_at: '2026-04-18T00:00:00.000Z',
          kiloclaw_price_version: '2026-05-10',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    mockQueryKiloclawActiveUserIds.mockResolvedValue(new Set());
    const { env, trialInactivitySendBatch } = createEnvWithQueueMocks(vi.fn());

    const summary = await runSweep(
      env,
      {
        runId: '76767676-7676-4676-8676-767676767670',
        sweep: 'trial_inactivity_stop',
      },
      1
    );

    expect(summary.trial_inactivity_candidates).toBe(0);
    expect(summary.trial_inactivity_stop_messages_enqueued).toBe(0);
    expect(mockQueryKiloclawActiveUserIds).not.toHaveBeenCalled();
    expect(trialInactivitySendBatch).not.toHaveBeenCalled();
  });

  it('enqueues stop-candidate work for personal trial instances with no qualifying Snowflake usage', async () => {
    const instanceId = '77777777-7777-4777-8777-777777777777';
    const { db, updates } = createMockDb([
      [
        {
          subscription_id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_77777777777747778777777777777777',
          organization_id: null,
          instance_destroyed_at: null,
          instance_created_at: '2026-04-18T00:00:00.000Z',
          kiloclaw_price_version: '2026-03-19',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    mockQueryKiloclawActiveUserIds.mockResolvedValue(new Set());
    const { env, trialInactivitySendBatch } = createEnvWithQueueMocks(vi.fn());

    const summary = await runSweep(
      env,
      {
        runId: '77777777-7777-4777-8777-777777777770',
        sweep: 'trial_inactivity_stop',
      },
      1
    );

    expect(summary.trial_inactivity_candidates).toBe(1);
    expect(summary.trial_inactivity_batches).toBe(1);
    expect(summary.trial_inactivity_stop_messages_enqueued).toBe(1);
    expect(summary.trial_inactivity_stops).toBe(0);
    expect(trialInactivitySendBatch).toHaveBeenCalledWith([
      {
        body: {
          kind: 'trial_inactivity_stop_candidate',
          runId: '77777777-7777-4777-8777-777777777770',
          sweep: 'trial_inactivity_stop_candidate',
          subscriptionId: 'sub-1',
          userId: 'user-1',
          instanceId,
        },
      },
    ]);
    expect(updates).toEqual([]);
  });

  it('skips stopping candidates with qualifying Snowflake usage and logs the skip reason', async () => {
    const instanceId = '78787878-7878-4878-8878-787878787878';
    const { db, updates } = createMockDb([
      [
        {
          subscription_id: 'sub-active-usage',
          user_id: 'user-with-usage',
          instance_id: instanceId,
          sandbox_id: 'ki_78787878787848788878787878787878',
          organization_id: null,
          instance_destroyed_at: null,
          instance_created_at: '2026-04-18T00:00:00.000Z',
          kiloclaw_price_version: '2026-03-19',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    mockQueryKiloclawActiveUserIds.mockResolvedValue(new Set(['user-with-usage']));
    const fetch = vi.fn();

    const summary = await runSweep(
      createEnv(fetch),
      {
        runId: '78787878-7878-4878-8878-787878787870',
        sweep: 'trial_inactivity_stop',
      },
      1
    );

    expect(summary.trial_inactivity_candidates).toBe(1);
    expect(summary.trial_inactivity_stop_messages_enqueued).toBe(0);
    expect(summary.trial_inactivity_stops).toBe(0);
    expect(summary.errors).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(loggedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Skipping trial inactivity stop because Snowflake reported recent usage',
          event: 'subscription_row_skipped',
          outcome: 'skipped',
          reason: 'recent_snowflake_usage',
          userId: 'user-with-usage',
          instanceId,
        }),
      ])
    );
  });

  it('enqueues stop-candidate work during dry-run mode without mutating the database', async () => {
    const instanceId = '88888888-8888-4888-8888-888888888888';
    const { db, updates } = createMockDb([
      [
        {
          subscription_id: 'sub-1',
          user_id: 'user-1',
          instance_id: instanceId,
          sandbox_id: 'ki_88888888888848888888888888888888',
          organization_id: null,
          instance_destroyed_at: null,
          instance_created_at: '2026-04-18T00:00:00.000Z',
          kiloclaw_price_version: '2026-03-19',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    mockQueryKiloclawActiveUserIds.mockResolvedValue(new Set());
    const env = createEnv(vi.fn());
    env.TRIAL_INACTIVITY_STOP_DRY_RUN = 'true';

    const summary = await runSweep(
      env,
      {
        runId: '88888888-8888-4888-8888-888888888880',
        sweep: 'trial_inactivity_stop',
      },
      1
    );

    expect(summary.trial_inactivity_stop_messages_enqueued).toBe(1);
    expect(summary.trial_inactivity_dry_run_candidates).toBe(0);
    expect(summary.trial_inactivity_stops).toBe(0);
    expect(updates).toEqual([]);
  });

  it('logs and skips the run when Snowflake config is missing', async () => {
    const { db } = createMockDb([[]]);
    mockGetWorkerDb.mockReturnValue(db);
    mockGetMissingSnowflakeConfig.mockReturnValue(['SNOWFLAKE_ACCOUNT_HOST']);

    const summary = await runSweep(
      createEnv(vi.fn()),
      {
        runId: '99999999-9999-4999-8999-999999999999',
        sweep: 'trial_inactivity_stop',
      },
      1
    );

    expect(summary.errors).toBe(1);
    expect(summary.trial_inactivity_candidates).toBe(0);
    expect(mockQueryKiloclawActiveUserIds).not.toHaveBeenCalled();
  });

  it('stops a stop-candidate message with a single stop call and writes the marker', async () => {
    const instanceId = '98989898-9898-4898-8898-989898989898';
    const { db, updates } = createMockDb([
      [
        {
          subscription_id: 'sub-stop',
          user_id: 'user-stop',
          instance_id: instanceId,
          sandbox_id: 'ki_98989898989848988898989898989898',
          organization_id: null,
          instance_destroyed_at: null,
          instance_created_at: '2026-04-18T00:00:00.000Z',
          kiloclaw_price_version: '2026-03-19',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url.includes('/api/platform/stop')) {
        return new Response(
          JSON.stringify({
            ok: true,
            stopped: true,
            previousStatus: 'running',
            currentStatus: 'stopped',
            stoppedAt: Date.parse('2026-04-22T00:00:00.000Z'),
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const summary = await processTrialInactivityStopCandidate(
      createEnv(fetch),
      {
        kind: 'trial_inactivity_stop_candidate',
        runId: '98989898-9898-4898-8898-989898989890',
        sweep: 'trial_inactivity_stop_candidate',
        subscriptionId: 'sub-stop',
        userId: 'user-stop',
        instanceId,
      },
      1
    );

    expect(summary.trial_inactivity_candidates).toBe(1);
    expect(summary.trial_inactivity_stops).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls[0]?.[0] instanceof Request
        ? fetch.mock.calls[0][0].url
        : String(fetch.mock.calls[0]?.[0])
    ).toContain('/api/platform/stop');
    const stopRequest = fetch.mock.calls[0]?.[0];
    expect(stopRequest).toBeInstanceOf(Request);
    if (!(stopRequest instanceof Request)) {
      throw new Error('expected Request');
    }
    expect(await stopRequest.json()).toEqual({
      userId: 'user-stop',
      reason: 'trial_inactivity',
    });
    expect(updates).toContainEqual(
      expect.objectContaining({ inactive_trial_stopped_at: '2026-04-22T00:00:00.000Z' })
    );
  });

  it('treats a non-running stop-candidate message as a skip without marking the row', async () => {
    const instanceId = '97979797-9797-4979-8979-979797979797';
    const { db, updates } = createMockDb([
      [
        {
          subscription_id: 'sub-skipped',
          user_id: 'user-skipped',
          instance_id: instanceId,
          sandbox_id: 'ki_97979797979749798979797979797979',
          organization_id: null,
          instance_destroyed_at: null,
          instance_created_at: '2026-04-18T00:00:00.000Z',
          kiloclaw_price_version: '2026-03-19',
        },
      ],
    ]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            stopped: false,
            previousStatus: 'stopped',
            currentStatus: 'stopped',
            stoppedAt: Date.parse('2026-04-21T00:00:00.000Z'),
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
    );

    const summary = await processTrialInactivityStopCandidate(
      createEnv(fetch),
      {
        kind: 'trial_inactivity_stop_candidate',
        runId: '97979797-9797-4979-8979-979797979790',
        sweep: 'trial_inactivity_stop_candidate',
        subscriptionId: 'sub-skipped',
        userId: 'user-skipped',
        instanceId,
      },
      1
    );

    expect(summary.trial_inactivity_candidates).toBe(1);
    expect(summary.trial_inactivity_stops).toBe(0);
    expect(updates).toEqual([]);
    expect(loggedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Skipping trial inactivity stop because instance is not running',
          reason: 'instance_not_running',
          platformStatus: 'stopped',
          userId: 'user-skipped',
          instanceId,
        }),
      ])
    );
  });

  it('skips stop-candidate messages that are no longer eligible before calling the platform', async () => {
    const { db, updates } = createMockDb([[]]);
    mockGetWorkerDb.mockReturnValue(db);
    const fetch = vi.fn();

    const summary = await processTrialInactivityStopCandidate(
      createEnv(fetch),
      {
        kind: 'trial_inactivity_stop_candidate',
        runId: '96969696-9696-4969-8969-969696969690',
        sweep: 'trial_inactivity_stop_candidate',
        subscriptionId: 'sub-missing',
        userId: 'user-missing',
        instanceId: '96969696-9696-4969-8969-969696969696',
      },
      1
    );

    expect(summary.trial_inactivity_candidates).toBe(0);
    expect(summary.trial_inactivity_stops).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(loggedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Skipping trial inactivity stop because candidate is no longer eligible',
          reason: 'candidate_no_longer_eligible',
          userId: 'user-missing',
          instanceId: '96969696-9696-4969-8969-969696969696',
        }),
      ])
    );
  });
});
