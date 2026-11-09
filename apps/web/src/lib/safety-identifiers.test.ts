import { count, eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  generateOpenRouterDownstreamSafetyIdentifier,
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY,
  SAFETY_IDENTIFIER_BACKFILL_STATE_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { POST as manualTrigger } from '@/app/admin/api/safety-identifiers/route';
import { GET as cronTrigger } from '@/app/api/cron/backfill-safety-identifiers/route';
import {
  getSafetyIdentifierStatus,
  regenerateSafetyIdentifiers,
  SAFETY_IDENTIFIER_BACKFILL_ERROR,
  SAFETY_IDENTIFIER_BATCH_SIZE,
  SAFETY_IDENTIFIER_WORK_BUDGET_MS,
} from './safety-identifiers';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(), eval: jest.fn() },
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

const storage = new Map<string, string>();
const originalOrg = process.env.OPENROUTER_ORG_ID;
let failCheckpoint = false;
let failRelease = false;
let replaceOwner = false;
let checkpointHook: (() => Promise<void>) | undefined;

function persistedState() {
  return JSON.parse(storage.get(SAFETY_IDENTIFIER_BACKFILL_STATE_KEY) ?? 'null');
}

function regenerate() {
  return regenerateSafetyIdentifiers({ deadlineAt: Date.now() + SAFETY_IDENTIFIER_WORK_BUDGET_MS });
}

async function insertUsers(amount: number) {
  for (let start = 0; start < amount; start += 500) {
    await db
      .insert(kilocode_users)
      .values(
        Array.from({ length: Math.min(500, amount - start) }, (_, offset) =>
          defineTestUser({ id: `synthetic-${String(start + offset).padStart(5, '0')}` })
        )
      );
  }
}

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanupDbForTest();
  storage.clear();
  failCheckpoint = false;
  failRelease = false;
  replaceOwner = false;
  checkpointHook = undefined;
  process.env.OPENROUTER_ORG_ID = 'synthetic-org';
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: defineTestUser({ is_admin: true }),
    authFailedResponse: null,
  });
  jest
    .mocked(redisClient.get)
    .mockImplementation(
      (async (key: string) => storage.get(key) ?? null) as typeof redisClient.get
    );
  jest.mocked(redisClient.set).mockImplementation((async (key: string, value: string) => {
    if (storage.has(key)) return null;
    storage.set(key, value);
    return 'OK';
  }) as typeof redisClient.set);
  jest.mocked(redisClient.eval).mockImplementation((async (
    script: string,
    keys: string[],
    args: string[]
  ) => {
    expect(script).toContain("redis.call('GET', KEYS[1]) ~= ARGV[1]");
    if (keys.length === 2) {
      const next = JSON.parse(args[1]);
      if (next.processed > 0 && replaceOwner) storage.set(keys[0], 'replacement-owner');
      if (storage.get(keys[0]) !== args[0]) return 0;
      if (next.processed > 0 && failCheckpoint) {
        failCheckpoint = false;
        throw new Error('synthetic Redis failure');
      }
      await checkpointHook?.();
      storage.set(keys[1], args[1]);
      return 1;
    }
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    if (failRelease) throw new Error('synthetic Redis release failure');
    if (storage.get(keys[0]) !== args[0]) return 0;
    storage.delete(keys[0]);
    return 1;
  }) as typeof redisClient.eval);
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalOrg === undefined) delete process.env.OPENROUTER_ORG_ID;
  else process.env.OPENROUTER_ORG_ID = originalOrg;
});

describe('safety identifier regeneration', () => {
  test('overwrites all three fields for missing, populated, OAuth, bot and deletion-requested users', async () => {
    const updatedAt = '2025-01-01T00:00:00.000Z';
    const users = await Promise.all([
      insertTestUser({ id: '', updated_at: updatedAt }),
      insertTestUser({
        id: 'oauth/synthetic-provider/account',
        updated_at: updatedAt,
        openrouter_upstream_safety_identifier: 'stale-upstream',
        openrouter_downstream_safety_identifier: 'stale-downstream',
        vercel_downstream_safety_identifier: 'stale-vercel',
      }),
      insertTestUser({
        id: 'synthetic-bot',
        is_bot: true,
        account_deletion_requested_at: updatedAt,
        updated_at: updatedAt,
        openrouter_downstream_safety_identifier: 'partially-populated',
      }),
    ]);

    await expect(regenerate()).resolves.toEqual({ processed: 3, remaining: false, skipped: false });
    for (const user of users) {
      const [actual] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
      expect(actual).toMatchObject({
        openrouter_upstream_safety_identifier: generateOpenRouterUpstreamSafetyIdentifier(user.id),
        openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(
          user.id
        ),
        vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(user.id),
      });
      expect(new Date(actual.updated_at).toISOString()).toBe(updatedAt);
    }
    expect(persistedState()).toMatchObject({ status: 'completed', processed: 3, total: 3 });
    expect(storage.has(SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY)).toBe(false);
    expect(jest.mocked(redisClient.set).mock.calls[0][2]).toEqual({ nx: true, ex: 360 });
  });

  test('reports read-only pending progress without querying users or starting a run', async () => {
    const select = jest.spyOn(db, 'select');
    await expect(getSafetyIdentifierStatus()).resolves.toEqual({
      running: false,
      batchSize: 5000,
      scheduleMinutes: 3,
      backfill: {
        status: 'pending',
        processed: 0,
        total: null,
        cursor: null,
        startedAt: null,
        updatedAt: null,
        completedAt: null,
        lastBatchProcessed: 0,
        lastError: null,
      },
    });
    expect(redisClient.set).not.toHaveBeenCalled();
    expect(redisClient.eval).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  test('uses five SQL chunks and resumes the text keyset across invocations with a finite high water', async () => {
    await insertUsers(SAFETY_IDENTIFIER_BATCH_SIZE + 1);
    const execute = jest.spyOn(db, 'execute');
    await expect(regenerate()).resolves.toEqual({
      processed: 5000,
      remaining: true,
      skipped: false,
    });
    expect(execute).toHaveBeenCalledTimes(5);
    expect(persistedState()).toMatchObject({
      processed: 5000,
      total: 5001,
      cursor: 'synthetic-04999',
      highWaterId: 'synthetic-05000',
    });
    const newUser = await insertTestUser({
      id: 'zz-synthetic-new-user',
      openrouter_upstream_safety_identifier: 'new-user-upstream',
      openrouter_downstream_safety_identifier: 'new-user-downstream',
      vercel_downstream_safety_identifier: 'new-user-vercel',
    });
    await expect(regenerate()).resolves.toEqual({ processed: 1, remaining: false, skipped: false });
    expect(execute).toHaveBeenCalledTimes(6);
    expect(persistedState()).toMatchObject({
      processed: 5001,
      total: 5001,
      cursor: 'synthetic-05000',
      status: 'completed',
      lastBatchProcessed: 1,
    });
    const [outsideSnapshot] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, newUser.id));
    expect(outsideSnapshot.openrouter_upstream_safety_identifier).toBe('new-user-upstream');
    const [missing] = await db
      .select({ count: count() })
      .from(kilocode_users)
      .where(
        eq(
          kilocode_users.openrouter_downstream_safety_identifier,
          generateOpenRouterDownstreamSafetyIdentifier('synthetic-05000')
        )
      );
    expect(missing.count).toBe(1);
  }, 30_000);

  test('does not restart a completed pass, even after a later user is inserted', async () => {
    await insertTestUser();
    await regenerate();
    const state = storage.get(SAFETY_IDENTIFIER_BACKFILL_STATE_KEY);
    await insertTestUser();
    const execute = jest.spyOn(db, 'execute');
    await expect(regenerate()).resolves.toEqual({ processed: 0, remaining: false, skipped: false });
    expect(execute).not.toHaveBeenCalled();
    expect(storage.get(SAFETY_IDENTIFIER_BACKFILL_STATE_KEY)).toBe(state);
  });

  test('starts a fresh finite pass after completed configuration rotation and overwrites all identifiers', async () => {
    await insertUsers(2);
    await expect(regenerate()).resolves.toEqual({ processed: 2, remaining: false, skipped: false });
    const completed = persistedState();
    const users = await db.select().from(kilocode_users);
    for (const user of users) {
      await db
        .update(kilocode_users)
        .set({
          openrouter_upstream_safety_identifier: `stale-upstream-${user.id}`,
          openrouter_downstream_safety_identifier: `stale-downstream-${user.id}`,
          vercel_downstream_safety_identifier: `stale-vercel-${user.id}`,
        })
        .where(eq(kilocode_users.id, user.id));
    }
    const newUser = await insertTestUser({ id: 'zz-synthetic-later-user' });
    process.env.OPENROUTER_ORG_ID = 'rotated-synthetic-org';

    await expect(regenerate()).resolves.toEqual({ processed: 3, remaining: false, skipped: false });
    expect(persistedState()).toMatchObject({
      status: 'completed',
      processed: 3,
      total: 3,
      lastBatchProcessed: 3,
      highWaterId: newUser.id,
      cursor: newUser.id,
      lastError: null,
    });
    expect(persistedState().targetFingerprint).not.toBe(completed.targetFingerprint);
    for (const user of [...users, newUser]) {
      const [actual] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
      expect(actual).toMatchObject({
        openrouter_upstream_safety_identifier: generateOpenRouterUpstreamSafetyIdentifier(user.id),
        openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(
          user.id
        ),
        vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(user.id),
      });
    }
  });

  test('preserves committed success and completed progress when lock release fails', async () => {
    const user = await insertTestUser();
    failRelease = true;

    await expect(regenerate()).resolves.toEqual({ processed: 1, remaining: false, skipped: false });
    expect(persistedState()).toMatchObject({
      status: 'completed',
      processed: 1,
      cursor: user.id,
      lastError: null,
    });
    const [actual] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
    expect(actual.openrouter_upstream_safety_identifier).toBe(
      generateOpenRouterUpstreamSafetyIdentifier(user.id)
    );
    expect(storage.has(SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      'Safety identifier regeneration lock release failed; waiting for lock expiry.'
    );
  });

  test('preserves the original batch error when lock release also fails', async () => {
    await insertTestUser();
    const originalError = new Error('synthetic database failure');
    jest.spyOn(db, 'execute').mockRejectedValueOnce(originalError);
    failRelease = true;

    await expect(regenerate()).rejects.toMatchObject({
      message: SAFETY_IDENTIFIER_BACKFILL_ERROR,
      cause: originalError,
    });
    expect(persistedState()).toMatchObject({
      status: 'running',
      processed: 0,
      cursor: null,
      lastError: SAFETY_IDENTIFIER_BACKFILL_ERROR,
    });
    expect(storage.has(SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      'Safety identifier regeneration lock release failed; waiting for lock expiry.'
    );
  });

  test('completes an empty database without issuing an update', async () => {
    const execute = jest.spyOn(db, 'execute');
    await expect(regenerate()).resolves.toEqual({ processed: 0, remaining: false, skipped: false });
    expect(execute).not.toHaveBeenCalled();
    expect(persistedState()).toMatchObject({
      status: 'completed',
      total: 0,
      processed: 0,
      cursor: null,
    });
    await expect(regenerate()).resolves.toEqual({ processed: 0, remaining: false, skipped: false });
  });

  test('retains the cursor on a failed SQL statement and saves only a sanitized error', async () => {
    const user = await insertTestUser();
    const driverError = Object.assign(new Error('synthetic sensitive driver details'), {
      code: '40001',
    });
    const originalError = new Error('synthetic sensitive database error', { cause: driverError });
    originalError.name = 'DrizzleQueryError';
    jest.spyOn(db, 'execute').mockRejectedValueOnce(originalError);
    await expect(regenerate()).rejects.toMatchObject({
      message: SAFETY_IDENTIFIER_BACKFILL_ERROR,
      cause: originalError,
    });
    expect(console.error).toHaveBeenCalledWith('Safety identifier regeneration failed', {
      exception_name: 'DrizzleQueryError',
      database_error_code: '40001',
    });
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(
      'synthetic sensitive'
    );
    expect(persistedState()).toMatchObject({
      cursor: null,
      processed: 0,
      status: 'running',
      lastError: SAFETY_IDENTIFIER_BACKFILL_ERROR,
    });
    const [unchanged] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(unchanged.openrouter_upstream_safety_identifier).toBeNull();
    await expect(regenerate()).resolves.toMatchObject({ processed: 1, remaining: false });
  });

  test('safely replays a committed write when Redis failed before its checkpoint', async () => {
    const user = await insertTestUser();
    failCheckpoint = true;
    await expect(regenerate()).rejects.toThrow(SAFETY_IDENTIFIER_BACKFILL_ERROR);
    const [committed] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(committed.openrouter_upstream_safety_identifier).toBe(
      generateOpenRouterUpstreamSafetyIdentifier(user.id)
    );
    expect(persistedState()).toMatchObject({ cursor: null, processed: 0 });
    await expect(regenerate()).resolves.toMatchObject({ processed: 1, remaining: false });
  });

  test('keeps prior committed progress when a later chunk fails', async () => {
    await insertUsers(1001);
    const execute = db.execute.bind(db);
    jest
      .spyOn(db, 'execute')
      .mockImplementationOnce(execute)
      .mockRejectedValueOnce(new Error('synthetic database failure'));
    await expect(regenerate()).rejects.toThrow(SAFETY_IDENTIFIER_BACKFILL_ERROR);
    expect(persistedState()).toMatchObject({
      cursor: 'synthetic-00999',
      processed: 1000,
      lastBatchProcessed: 1000,
    });
    await expect(regenerate()).resolves.toMatchObject({ processed: 1, remaining: false });
  });

  test('does not overwrite another owner checkpoint or release its lock', async () => {
    await insertTestUser();
    replaceOwner = true;
    await expect(regenerate()).rejects.toThrow(SAFETY_IDENTIFIER_BACKFILL_ERROR);
    expect(persistedState()).toMatchObject({ cursor: null, processed: 0, lastError: null });
    expect(storage.get(SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY)).toBe('replacement-owner');
  });

  test('stops at the internal deadline without advancing over uncommitted rows', async () => {
    await insertUsers(1001);
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    checkpointHook = async () => {
      if (persistedState()?.processed === 0) now.mockReturnValue(240_000);
    };
    await expect(regenerateSafetyIdentifiers({ deadlineAt: 240_000 })).resolves.toMatchObject({
      processed: 1000,
      remaining: true,
    });
    expect(persistedState()).toMatchObject({ processed: 1000, cursor: 'synthetic-00999' });
  });

  test.each([undefined, ''])(
    'fails before Redis or database mutation when org configuration is %s',
    async org => {
      if (org === undefined) delete process.env.OPENROUTER_ORG_ID;
      else process.env.OPENROUTER_ORG_ID = org;
      await expect(regenerate()).rejects.toThrow('OPENROUTER_ORG_ID is not configured');
      expect(redisClient.set).not.toHaveBeenCalled();
      expect(redisClient.eval).not.toHaveBeenCalled();
    }
  );

  test.each(['{', '{}', '{"version":0}'])(
    'fails closed for corrupt or incompatible persisted state: %s',
    async value => {
      await insertTestUser();
      storage.set(SAFETY_IDENTIFIER_BACKFILL_STATE_KEY, value);
      const execute = jest.spyOn(db, 'execute');
      await expect(regenerate()).rejects.toThrow(SAFETY_IDENTIFIER_BACKFILL_ERROR);
      expect(execute).not.toHaveBeenCalled();
      expect(storage.get(SAFETY_IDENTIFIER_BACKFILL_STATE_KEY)).toBe(value);
      await expect(getSafetyIdentifierStatus()).rejects.toThrow();
    }
  );

  test('does not mix configuration changes into an existing run', async () => {
    await insertTestUser();
    await regenerateSafetyIdentifiers({ deadlineAt: 0 });
    const state = persistedState();
    process.env.OPENROUTER_ORG_ID = 'different-synthetic-org';
    const execute = jest.spyOn(db, 'execute');
    await expect(regenerate()).rejects.toThrow(SAFETY_IDENTIFIER_BACKFILL_ERROR);
    expect(execute).not.toHaveBeenCalled();
    expect(persistedState()).toMatchObject({
      targetFingerprint: state.targetFingerprint,
      cursor: state.cursor,
      processed: state.processed,
      lastError: SAFETY_IDENTIFIER_BACKFILL_ERROR,
    });
  });

  test('fails closed when Redis lock acquisition or state reading fails', async () => {
    await insertTestUser();
    const execute = jest.spyOn(db, 'execute');
    jest.mocked(redisClient.set).mockRejectedValueOnce(new Error('synthetic Redis unavailable'));
    await expect(regenerate()).rejects.toThrow();
    jest.mocked(redisClient.get).mockRejectedValueOnce(new Error('synthetic Redis unavailable'));
    await expect(regenerate()).rejects.toThrow(SAFETY_IDENTIFIER_BACKFILL_ERROR);
    expect(execute).not.toHaveBeenCalled();
    expect(storage.has(SAFETY_IDENTIFIER_BACKFILL_STATE_KEY)).toBe(false);
  });

  test('admits only one concurrent cron/manual invocation and skips a contended cron successfully', async () => {
    await insertTestUser();
    let enter: (() => void) | undefined;
    let resume: (() => void) | undefined;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const paused = new Promise<void>(resolve => {
      resume = resolve;
    });
    checkpointHook = async () => {
      enter?.();
      await paused;
    };
    const request = () =>
      new Request('http://localhost/api/cron/backfill-safety-identifiers', {
        headers: { authorization: 'Bearer cron-secret' },
      });
    const first = cronTrigger(request());
    await entered;
    const manual = await manualTrigger();
    expect(manual.status).toBe(409);
    const skipped = await cronTrigger(request());
    expect(skipped.status).toBe(200);
    await expect(skipped.json()).resolves.toEqual({ processed: 0, remaining: true, skipped: true });
    expect(await getSafetyIdentifierStatus()).toMatchObject({ running: true });
    checkpointHook = undefined;
    resume?.();
    expect((await first).status).toBe(200);
    expect(persistedState()).toMatchObject({ processed: 1, status: 'completed' });
  });
});
