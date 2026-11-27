import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { asc } from 'drizzle-orm';

import {
  leaderboard_usage_hourly,
  leaderboard_usage_hours,
  microdollar_usage,
  microdollar_usage_metadata,
  mode,
} from '@kilocode/db/schema';
import { cleanupDbForTest, db, type DrizzleDatabase } from '@kilocode/web-shared/lib/drizzle';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  buildLeaderboardUsageHours,
  eligibleLeaderboardUsageHours,
  rebuildLeaderboardUsageHour,
} from '@/lib/leaderboard-usage-hourly-rollup';

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/utils.server'),
  errorExceptInTest: jest.fn(),
  logExceptInTest: jest.fn(),
}));

type UsageInput = {
  created_at: string;
  provider?: string | null;
  requested_model?: string | null;
  model?: string | null;
  inference_provider?: string | null;
  mode?: string | null;
  is_user_byok?: boolean | null;
  has_error?: boolean;
  withMetadata?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cache_hit_tokens?: number;
  cost?: number;
};

const modeIds = new Map<string, number>();

async function modeId(name: string): Promise<number> {
  const cached = modeIds.get(name);
  if (cached !== undefined) return cached;
  const [row] = await db.insert(mode).values({ mode: name }).returning({ id: mode.mode_id });
  modeIds.set(name, row.id);
  return row.id;
}

async function insertUsage(input: UsageInput): Promise<void> {
  const id = randomUUID();
  await db.insert(microdollar_usage).values({
    id,
    kilo_user_id: 'leaderboard-rollup-user',
    cost: input.cost ?? 100,
    input_tokens: input.input_tokens ?? 1_000,
    output_tokens: input.output_tokens ?? 500,
    cache_write_tokens: 0,
    cache_hit_tokens: input.cache_hit_tokens ?? 200,
    created_at: input.created_at,
    provider: input.provider === undefined ? 'openrouter' : input.provider,
    requested_model: input.requested_model === undefined ? 'acme/model' : input.requested_model,
    model: input.model === undefined ? 'acme/model' : input.model,
    inference_provider:
      input.inference_provider === undefined ? 'acme-cloud' : input.inference_provider,
    has_error: input.has_error ?? false,
  });
  if (input.withMetadata === false) return;
  await db.insert(microdollar_usage_metadata).values({
    id,
    created_at: input.created_at,
    message_id: `message-${id}`,
    mode_id: input.mode ? await modeId(input.mode) : null,
    is_user_byok: input.is_user_byok === undefined ? false : input.is_user_byok,
  });
}

async function rollupRows() {
  const rows = await db
    .select()
    .from(leaderboard_usage_hourly)
    .orderBy(
      asc(leaderboard_usage_hourly.hour_start),
      asc(leaderboard_usage_hourly.requested_model),
      asc(leaderboard_usage_hourly.mode)
    );
  return rows.map(({ id: _id, hour_start, ...row }) => ({
    hour_start: new Date(hour_start).toISOString(),
    ...row,
  }));
}

async function recordedHours() {
  const rows = await db
    .select()
    .from(leaderboard_usage_hours)
    .orderBy(asc(leaderboard_usage_hours.hour_start));
  return rows.map(row => ({ hour_start: new Date(row.hour_start).toISOString(), rows: row.rows }));
}

/** Shifts `Date.now()` forward by `ms` from the moment this is called. */
function jumpClockForward(ms: number) {
  const realNow = Date.now.bind(Date);
  return jest.spyOn(Date, 'now').mockImplementation(() => realNow() + ms);
}

describe('leaderboard usage hourly rollup', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    modeIds.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('aggregates one UTC hour across slices, keyed by provider, models, mode and BYOK', async () => {
    await insertUsage({ created_at: '2026-11-10T08:00:00.000Z', mode: 'code' });
    await insertUsage({
      created_at: '2026-11-10T08:37:30.000Z',
      mode: 'code',
      has_error: true,
      cost: 300,
    });
    await insertUsage({ created_at: '2026-11-10T08:59:59.999Z', mode: 'plan' });
    await insertUsage({
      created_at: '2026-11-10T08:10:00.000Z',
      requested_model: 'other/model',
      is_user_byok: true,
      mode: 'code',
    });
    await insertUsage({
      created_at: '2026-11-10T08:15:00.000Z',
      requested_model: 'no/metadata',
      withMetadata: false,
    });
    // A NULL flag and a missing metadata row both count as not BYOK.
    await insertUsage({
      created_at: '2026-11-10T08:20:00.000Z',
      requested_model: 'no/metadata',
      is_user_byok: null,
    });
    await insertUsage({ created_at: '2026-11-10T07:59:59.999Z', mode: 'code' });
    await insertUsage({ created_at: '2026-11-10T09:00:00.000Z', mode: 'code' });

    const written = await rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', { db });

    expect(written).toEqual({
      rows: 4,
      slices: 12,
      durationMs: expect.any(Number),
      slowestSliceMs: expect.any(Number),
    });
    const shared = {
      hour_start: '2026-11-10T08:00:00.000Z',
      provider: 'openrouter',
      model: 'acme/model',
      inference_provider: 'acme-cloud',
    };
    expect(await rollupRows()).toEqual([
      {
        ...shared,
        requested_model: 'acme/model',
        mode: 'code',
        is_user_byok: false,
        input_tokens: 2_000,
        output_tokens: 1_000,
        cache_hit_tokens: 400,
        cost_microdollars: 400,
        request_count: 2,
        error_count: 1,
      },
      {
        ...shared,
        requested_model: 'acme/model',
        mode: 'plan',
        is_user_byok: false,
        input_tokens: 1_000,
        output_tokens: 500,
        cache_hit_tokens: 200,
        cost_microdollars: 100,
        request_count: 1,
        error_count: 0,
      },
      {
        ...shared,
        requested_model: 'no/metadata',
        mode: null,
        is_user_byok: false,
        input_tokens: 2_000,
        output_tokens: 1_000,
        cache_hit_tokens: 400,
        cost_microdollars: 200,
        request_count: 2,
        error_count: 0,
      },
      {
        ...shared,
        requested_model: 'other/model',
        mode: 'code',
        is_user_byok: true,
        input_tokens: 1_000,
        output_tokens: 500,
        cache_hit_tokens: 200,
        cost_microdollars: 100,
        request_count: 1,
        error_count: 0,
      },
    ]);
    expect(await recordedHours()).toEqual([{ hour_start: '2026-11-10T08:00:00.000Z', rows: 4 }]);
  });

  test('replaces the rows of a rebuilt hour without touching other hours', async () => {
    await insertUsage({ created_at: '2026-11-10T08:30:00.000Z' });
    await insertUsage({ created_at: '2026-11-10T09:30:00.000Z' });
    await rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', { db });
    await rebuildLeaderboardUsageHour('2026-11-10T09:00:00.000Z', { db });

    await insertUsage({ created_at: '2026-11-10T08:45:00.000Z', requested_model: 'acme/new' });
    await rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', { db });

    expect(
      (await rollupRows()).map(row => ({
        hour: row.hour_start,
        model: row.requested_model,
        requests: row.request_count,
      }))
    ).toEqual([
      { hour: '2026-11-10T08:00:00.000Z', model: 'acme/model', requests: 1 },
      { hour: '2026-11-10T08:00:00.000Z', model: 'acme/new', requests: 1 },
      { hour: '2026-11-10T09:00:00.000Z', model: 'acme/model', requests: 1 },
    ]);
    expect(await recordedHours()).toEqual([
      { hour_start: '2026-11-10T08:00:00.000Z', rows: 2 },
      { hour_start: '2026-11-10T09:00:00.000Z', rows: 1 },
    ]);
  });

  test('eligible hours settled for an hour and ended within the last four hours, oldest first', () => {
    expect(eligibleLeaderboardUsageHours(new Date('2026-11-10T10:15:00.000Z'))).toEqual([
      '2026-11-10T06:00:00.000Z',
      '2026-11-10T07:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
    ]);
    expect(eligibleLeaderboardUsageHours(new Date('2026-11-10T09:59:59.999Z'))).toEqual([
      '2026-11-10T05:00:00.000Z',
      '2026-11-10T06:00:00.000Z',
      '2026-11-10T07:00:00.000Z',
    ]);
    expect(eligibleLeaderboardUsageHours(new Date('2026-11-10T10:00:00.000Z'))).toEqual([
      '2026-11-10T05:00:00.000Z',
      '2026-11-10T06:00:00.000Z',
      '2026-11-10T07:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
    ]);
  });

  test('builds unrecorded eligible hours oldest first, recording empty hours and reading nothing older', async () => {
    const now = new Date('2026-11-10T10:15:00.000Z');
    await insertUsage({ created_at: '2026-11-10T05:30:00.000Z', requested_model: 'too/old' });
    await insertUsage({ created_at: '2026-11-10T06:30:00.000Z' });
    await insertUsage({ created_at: '2026-11-10T07:30:00.000Z' });
    await rebuildLeaderboardUsageHour('2026-11-10T07:00:00.000Z', { db });
    // Recorded hours are not rebuilt for usage that arrives after their build.
    await insertUsage({ created_at: '2026-11-10T07:40:00.000Z' });
    await insertUsage({ created_at: '2026-11-10T09:30:00.000Z', requested_model: 'unsettled' });

    const summary = await buildLeaderboardUsageHours({ db, now, deadline: Date.now() + 60_000 });

    expect(summary).toEqual({
      built: [
        expect.objectContaining({ hourStart: '2026-11-10T06:00:00.000Z', rows: 1, slices: 12 }),
        expect.objectContaining({ hourStart: '2026-11-10T08:00:00.000Z', rows: 0, slices: 12 }),
      ],
      failed: [],
      remaining: [],
      stoppedBy: null,
      durationMs: expect.any(Number),
    });
    expect(await recordedHours()).toEqual([
      { hour_start: '2026-11-10T06:00:00.000Z', rows: 1 },
      { hour_start: '2026-11-10T07:00:00.000Z', rows: 1 },
      { hour_start: '2026-11-10T08:00:00.000Z', rows: 0 },
    ]);
    expect(
      (await rollupRows()).map(row => ({ hour: row.hour_start, requests: row.request_count }))
    ).toEqual([
      { hour: '2026-11-10T06:00:00.000Z', requests: 1 },
      { hour: '2026-11-10T07:00:00.000Z', requests: 1 },
    ]);

    const next = await buildLeaderboardUsageHours({ db, now, deadline: Date.now() + 60_000 });
    expect(next.built).toEqual([]);
    expect(next.remaining).toEqual([]);
  });

  test('stops starting new hours once the deadline has passed', async () => {
    const summary = await buildLeaderboardUsageHours({
      db,
      now: new Date('2026-11-10T10:15:00.000Z'),
      deadline: Date.now(),
    });

    expect(summary).toEqual({
      built: [],
      failed: [],
      remaining: [
        '2026-11-10T06:00:00.000Z',
        '2026-11-10T07:00:00.000Z',
        '2026-11-10T08:00:00.000Z',
      ],
      stoppedBy: 'deadline',
      durationMs: expect.any(Number),
    });
    expect(await recordedHours()).toEqual([]);
  });

  test('an hour whose deadline passes before its last slice writes nothing', async () => {
    await insertUsage({ created_at: '2026-11-10T08:30:00.000Z' });
    await rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', { db });
    await insertUsage({ created_at: '2026-11-10T08:00:00.000Z' });
    let slices = 0;
    const slowDb = {
      transaction: ((callback: Parameters<DrizzleDatabase['transaction']>[0]) => {
        slices++;
        if (slices === 1) jumpClockForward(120_000);
        return db.transaction(callback);
      }) as DrizzleDatabase['transaction'],
    } as unknown as DrizzleDatabase;

    const build = await rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', {
      db: slowDb,
      deadline: Date.now() + 60_000,
    });

    expect(build).toEqual({ stopped: 'deadline' });
    expect(slices).toBe(1);
    expect((await rollupRows()).map(row => row.request_count)).toEqual([1]);
    expect(await recordedHours()).toEqual([{ hour_start: '2026-11-10T08:00:00.000Z', rows: 1 }]);
  });

  test('a run stopped partway through an hour reports it as remaining', async () => {
    // Each hour is 12 slice transactions and one write transaction, so the
    // 14th is the first slice of the second hour.
    let transactions = 0;
    const slowDb = {
      select: db.select.bind(db),
      transaction: ((callback: Parameters<DrizzleDatabase['transaction']>[0]) => {
        transactions++;
        if (transactions === 14) jumpClockForward(120_000);
        return db.transaction(callback);
      }) as DrizzleDatabase['transaction'],
    } as unknown as DrizzleDatabase;

    const summary = await buildLeaderboardUsageHours({
      db: slowDb,
      now: new Date('2026-11-10T10:15:00.000Z'),
      deadline: Date.now() + 60_000,
    });

    expect(summary.built.map(hour => hour.hourStart)).toEqual(['2026-11-10T06:00:00.000Z']);
    expect(summary.remaining).toEqual(['2026-11-10T07:00:00.000Z', '2026-11-10T08:00:00.000Z']);
    expect(summary.stoppedBy).toBe('deadline');
    expect(await recordedHours()).toEqual([{ hour_start: '2026-11-10T06:00:00.000Z', rows: 0 }]);
  });

  test('logs a failed hour with its stage, slice and Postgres code, then rethrows', async () => {
    const timeout = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    });
    let slices = 0;
    const failingDb = {
      transaction: ((callback: Parameters<DrizzleDatabase['transaction']>[0]) => {
        slices++;
        if (slices === 3) throw timeout;
        return db.transaction(callback);
      }) as DrizzleDatabase['transaction'],
    } as unknown as DrizzleDatabase;

    await expect(
      rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', { db: failingDb })
    ).rejects.toBe(timeout);

    const [line] = jest.mocked(errorExceptInTest).mock.calls.at(-1) as [string];
    expect(JSON.parse(line)).toEqual({
      type: 'leaderboard_usage_rollup_hour_failed',
      hourStart: '2026-11-10T08:00:00.000Z',
      stage: 'read',
      sliceStart: '2026-11-10T08:10:00.000Z',
      slicesCompleted: 2,
      durationMs: expect.any(Number),
      errorName: 'Error',
      postgresCode: '57014',
    });
    expect(await recordedHours()).toEqual([]);
  });

  test('a failed hour is reported and does not stop newer hours from being built', async () => {
    await insertUsage({ created_at: '2026-11-10T08:30:00.000Z' });
    let transactions = 0;
    const flakyDb = {
      select: db.select.bind(db),
      transaction: ((callback: Parameters<DrizzleDatabase['transaction']>[0]) => {
        transactions++;
        if (transactions === 1) throw new Error('Failed query');
        return db.transaction(callback);
      }) as DrizzleDatabase['transaction'],
    } as unknown as DrizzleDatabase;

    const summary = await buildLeaderboardUsageHours({
      db: flakyDb,
      now: new Date('2026-11-10T10:15:00.000Z'),
      deadline: Date.now() + 60_000,
    });

    expect(summary.failed).toEqual(['2026-11-10T06:00:00.000Z']);
    expect(summary.built.map(hour => hour.hourStart)).toEqual([
      '2026-11-10T07:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
    ]);
    expect(summary.remaining).toEqual([]);
    expect(summary.stoppedBy).toBeNull();
    expect(await recordedHours()).toEqual([
      { hour_start: '2026-11-10T07:00:00.000Z', rows: 0 },
      { hour_start: '2026-11-10T08:00:00.000Z', rows: 1 },
    ]);
  });

  test('concurrent rebuilds of the same hour leave one copy of its rows', async () => {
    await insertUsage({ created_at: '2026-11-10T08:30:00.000Z' });

    await Promise.all([
      rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', { db }),
      rebuildLeaderboardUsageHour('2026-11-10T08:00:00.000Z', { db }),
    ]);

    expect((await rollupRows()).map(row => row.request_count)).toEqual([1]);
    expect(await recordedHours()).toEqual([{ hour_start: '2026-11-10T08:00:00.000Z', rows: 1 }]);
  });
});
