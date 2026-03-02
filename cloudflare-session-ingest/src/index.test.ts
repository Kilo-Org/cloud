import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;
    constructor() {
      this.env = undefined;
      this.ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('./dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

import app from './index';
import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from './dos/SessionIngestDO';

type TestBindings = {
  HYPERDRIVE: { connectionString: string };
  SESSION_INGEST_DO: unknown;
  SESSION_ACCESS_CACHE_DO: unknown;
  NEXTAUTH_SECRET: unknown;
  NEXTAUTH_SECRET_RAW?: string;
};

function makeDbFakes() {
  const selectResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  const select = {
    from: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(selectResult())),
  };

  const db = {
    select: vi.fn(() => select),
  };

  return { db, selectResult };
}

const defaultEnv: TestBindings = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
  SESSION_INGEST_DO: {},
  SESSION_ACCESS_CACHE_DO: {},
  NEXTAUTH_SECRET: {},
  NEXTAUTH_SECRET_RAW: 'secret',
};

describe('public session route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 400 for invalid uuid', async () => {
    const res = await app.request('/session/not-a-uuid', {}, defaultEnv);
    expect(res.status).toBe(400);
  });

  it('returns 404 when public_id not found', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([]);

    const res = await app.request('/session/11111111-1111-4111-8111-111111111111', {}, defaultEnv);

    expect(res.status).toBe(404);
  });

  it('returns DO snapshot json with content-type', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        kilo_user_id: 'usr_123',
      },
    ]);

    const stub = {
      getAll: vi.fn(async () => '{"ok":true}'),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const res = await app.request('/session/11111111-1111-4111-8111-111111111111', {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe('{"ok":true}');
  });
});
