import { describe, test, expect, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { asc } from 'drizzle-orm';

import {
  leaderboard_usage_daily,
  microdollar_usage,
  microdollar_usage_metadata,
  mode,
} from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  buildLeaderboardUsageDays,
  leaderboardUsageWindow,
  rebuildLeaderboardUsageDay,
  settledLeaderboardUsageDays,
} from '@/lib/leaderboard-usage-rollup';

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

function rollupRows() {
  return db
    .select()
    .from(leaderboard_usage_daily)
    .orderBy(
      asc(leaderboard_usage_daily.usage_date),
      asc(leaderboard_usage_daily.requested_model),
      asc(leaderboard_usage_daily.mode)
    );
}

describe('leaderboard usage rollup', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    modeIds.clear();
  });

  test('aggregates one UTC day across hours, keyed by provider, models, mode and BYOK', async () => {
    await insertUsage({ created_at: '2026-11-10T00:00:00.000Z', mode: 'code' });
    await insertUsage({
      created_at: '2026-11-10T13:30:00.000Z',
      mode: 'code',
      has_error: true,
      cost: 300,
    });
    await insertUsage({ created_at: '2026-11-10T23:59:59.999Z', mode: 'plan' });
    await insertUsage({
      created_at: '2026-11-10T08:00:00.000Z',
      requested_model: 'other/model',
      is_user_byok: true,
      mode: 'code',
    });
    await insertUsage({
      created_at: '2026-11-10T09:00:00.000Z',
      requested_model: 'no/metadata',
      withMetadata: false,
    });
    // A NULL flag and a missing metadata row both count as not BYOK.
    await insertUsage({
      created_at: '2026-11-10T10:00:00.000Z',
      requested_model: 'no/metadata',
      is_user_byok: null,
    });
    await insertUsage({ created_at: '2026-11-09T23:59:59.999Z', mode: 'code' });
    await insertUsage({ created_at: '2026-11-11T00:00:00.000Z', mode: 'code' });

    const written = await rebuildLeaderboardUsageDay('2026-11-10', { readDb: db, db });

    expect(written).toBe(4);
    const shared = {
      usage_date: '2026-11-10',
      provider: 'openrouter',
      model: 'acme/model',
      inference_provider: 'acme-cloud',
    };
    expect((await rollupRows()).map(({ id: _id, ...row }) => row)).toEqual([
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
  });

  test('replaces the rows of a rebuilt day without touching other days', async () => {
    await insertUsage({ created_at: '2026-11-10T12:00:00.000Z' });
    await insertUsage({ created_at: '2026-11-11T12:00:00.000Z' });
    await rebuildLeaderboardUsageDay('2026-11-10', { readDb: db, db });
    await rebuildLeaderboardUsageDay('2026-11-11', { readDb: db, db });

    await insertUsage({ created_at: '2026-11-10T18:00:00.000Z' });
    await rebuildLeaderboardUsageDay('2026-11-10', { readDb: db, db });

    expect(
      (await rollupRows()).map(row => ({ date: row.usage_date, requests: row.request_count }))
    ).toEqual([
      { date: '2026-11-10', requests: 2 },
      { date: '2026-11-11', requests: 1 },
    ]);
  });

  test('the window is the seven complete UTC days before now, newest first', () => {
    expect(leaderboardUsageWindow(new Date('2026-11-10T00:20:00.000Z'))).toEqual([
      '2026-11-09',
      '2026-11-08',
      '2026-11-07',
      '2026-11-06',
      '2026-11-05',
      '2026-11-04',
      '2026-11-03',
    ]);
  });

  test('first builds a day an hour after it ends, once the replica has replayed that far', () => {
    const window = ['2026-11-09', '2026-11-08'];

    expect(settledLeaderboardUsageDays(window, new Date('2026-11-10T00:59:00.000Z'), null)).toEqual(
      ['2026-11-08']
    );
    expect(settledLeaderboardUsageDays(window, new Date('2026-11-10T01:00:00.000Z'), null)).toEqual(
      window
    );
    expect(
      settledLeaderboardUsageDays(
        window,
        new Date('2026-11-10T01:20:00.000Z'),
        Date.parse('2026-11-10T00:50:00.000Z')
      )
    ).toEqual(['2026-11-08']);
  });

  test('builds missing days newest first, at most two per run', async () => {
    const now = new Date('2026-11-10T01:20:00.000Z');
    for (const day of leaderboardUsageWindow(now)) {
      await insertUsage({ created_at: `${day}T12:00:00.000Z` });
    }
    await rebuildLeaderboardUsageDay('2026-11-08', { readDb: db, db });
    await insertUsage({ created_at: '2026-11-08T13:00:00.000Z' });

    const first = await buildLeaderboardUsageDays({
      readDb: db,
      db,
      now,
      deadline: Date.now() + 60_000,
    });
    const second = await buildLeaderboardUsageDays({
      readDb: db,
      db,
      now,
      deadline: Date.now() + 60_000,
    });

    expect(first.built.map(day => day.usageDate)).toEqual(['2026-11-09', '2026-11-07']);
    expect(first.remaining).toEqual(['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-03']);
    expect(second.built.map(day => day.usageDate)).toEqual(['2026-11-06', '2026-11-05']);
    // A built day is not rebuilt for the second row added after it was built.
    expect(
      (await rollupRows())
        .filter(row => row.usage_date === '2026-11-08')
        .map(row => row.request_count)
    ).toEqual([1]);
  });

  test('does not build yesterday within an hour of midnight', async () => {
    const now = new Date('2026-11-10T00:20:00.000Z');
    await insertUsage({ created_at: '2026-11-09T12:00:00.000Z' });

    const result = await buildLeaderboardUsageDays({
      readDb: db,
      db,
      now,
      deadline: Date.now() + 60_000,
    });

    expect(result.built.map(day => day.usageDate)).not.toContain('2026-11-09');
    expect(result.remaining).not.toContain('2026-11-09');
    expect(await rollupRows()).toEqual([]);
  });

  test('stops starting new days once the deadline has passed', async () => {
    const result = await buildLeaderboardUsageDays({
      readDb: db,
      db,
      now: new Date('2026-11-10T01:20:00.000Z'),
      deadline: Date.now(),
    });

    expect(result.built).toEqual([]);
    expect(result.remaining).toHaveLength(7);
  });

  test('a day whose deadline passes before its last slice writes nothing', async () => {
    await insertUsage({ created_at: '2026-11-10T12:00:00.000Z' });
    await rebuildLeaderboardUsageDay('2026-11-10', { readDb: db, db });
    await insertUsage({ created_at: '2026-11-10T13:00:00.000Z' });

    const rows = await rebuildLeaderboardUsageDay('2026-11-10', {
      readDb: db,
      db,
      deadline: Date.now(),
    });

    expect(rows).toBeNull();
    expect((await rollupRows()).map(row => row.request_count)).toEqual([1]);
  });
});
