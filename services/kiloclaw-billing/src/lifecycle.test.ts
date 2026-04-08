import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkerDb } = vi.hoisted(() => ({
  mockGetWorkerDb: vi.fn(),
}));

vi.mock('@kilocode/db', () => ({
  getWorkerDb: mockGetWorkerDb,
}));

import { runSweep } from './lifecycle.js';
import type { BillingWorkerEnv } from './types.js';

type SelectResult<T> = {
  limit: ReturnType<typeof vi.fn>;
  then: Promise<T[]>['then'];
};

function createSelectResult<T>(rows: T[]): SelectResult<T> {
  return {
    limit: vi.fn(async () => rows),
    then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
  };
}

function createMockDb(selectResults: unknown[][]) {
  const updates: Array<Record<string, unknown>> = [];
  const txUpdates: Array<Record<string, unknown>> = [];
  const txDeletes: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => createSelectResult(selectResults.shift() ?? [])),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      return {
        where: vi.fn(async () => undefined),
      };
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
      transaction,
    },
    updates,
    txUpdates,
    txDeletes,
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
