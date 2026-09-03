import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import type { microdollar_usage, microdollar_usage_metadata } from '@kilocode/db/schema';
import pg, { type QueryConfig } from 'pg';

import { run } from '../app/usage-evidence';
import type { SeedResult } from '../index';
import { closeSeedDb } from './db';

const email = 'ada@example.com';
const userId = 'oauth/usage-evidence-test';

type UsageRow = Partial<typeof microdollar_usage.$inferSelect> &
  Partial<typeof microdollar_usage_metadata.$inferSelect> & { metadataPresent?: boolean };

function usageRow(overrides: UsageRow = {}): UsageRow {
  return {
    kilo_user_id: userId,
    created_at: '2026-08-27 09:00:00+00',
    model: 'actual-model',
    requested_model: 'requested-model',
    provider: 'provider-a',
    has_error: false,
    cost: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    is_user_byok: false,
    status_code: 200,
    session_id: 'review-a',
    market_cost: null,
    ...overrides,
  };
}

function mockUsageDb(t: TestContext, rows: UsageRow[]) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-27T10:00:00.000Z') });
  const previousEnv = {
    POSTGRES_URL: process.env.POSTGRES_URL,
    USE_PRODUCTION_DB: process.env.USE_PRODUCTION_DB,
    DATABASE_CA: process.env.DATABASE_CA,
  };
  process.env.POSTGRES_URL = 'postgresql://localhost/usage-evidence-test';
  process.env.USE_PRODUCTION_DB = 'false';
  delete process.env.DATABASE_CA;
  t.after(async () => {
    await closeSeedDb();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  t.mock.method(pg.Pool.prototype, 'connect', () => {
    assert.fail('Usage evidence tests must not connect to a database');
  });
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`
    create table microdollar_usage (
      id text primary key, kilo_user_id text not null, created_at text not null,
      model text, requested_model text, provider text, has_error integer not null,
      cost integer not null, input_tokens integer not null, output_tokens integer not null,
      cache_write_tokens integer not null, cache_hit_tokens integer not null
    );
    create table microdollar_usage_metadata (
      id text primary key, is_user_byok integer, status_code integer, session_id text,
      market_cost integer
    );
  `);
  const insertUsage = sqlite.prepare(
    'insert into microdollar_usage values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertMetadata = sqlite.prepare(
    'insert into microdollar_usage_metadata values (?, ?, ?, ?, ?)'
  );
  for (const [index, row] of rows.entries()) {
    const id = row.id ?? `usage-${index}`;
    insertUsage.run(
      id,
      row.kilo_user_id ?? userId,
      new Date(row.created_at ?? '2026-08-27 09:00:00+00').toISOString(),
      row.model ?? null,
      row.requested_model ?? null,
      row.provider ?? null,
      Number(row.has_error ?? false),
      row.cost ?? 0,
      row.input_tokens ?? 0,
      row.output_tokens ?? 0,
      row.cache_write_tokens ?? 0,
      row.cache_hit_tokens ?? 0
    );
    if (row.metadataPresent !== false) {
      insertMetadata.run(
        id,
        row.is_user_byok === null || row.is_user_byok === undefined
          ? null
          : Number(row.is_user_byok),
        row.status_code ?? null,
        row.session_id ?? null,
        row.market_cost ?? null
      );
    }
  }
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = t.mock.method(
    pg.Pool.prototype,
    'query',
    async (config: QueryConfig, params: unknown[]) => {
      assert.match(config.text, /^select /);
      assert.equal(config.rowMode, 'array');
      if (config.text.includes('from "kilocode_users"')) {
        return { rows: [[userId, email]] };
      }
      assert.match(config.text, /from "microdollar_usage" left join "microdollar_usage_metadata"/);
      statements.push({ sql: config.text, params });
      const statement = sqlite.prepare(config.text);
      statement.setReturnArrays(true);
      statement.setReadBigInts(true);
      const columns = statement.columns();
      const bindings = Object.fromEntries(
        params.map((value, index) => {
          assert.ok(value === null || typeof value === 'string' || typeof value === 'number');
          return [`$${index + 1}`, value];
        })
      );
      return {
        rows: statement.all(bindings).map(row => {
          assert.ok(Array.isArray(row));
          return row.map((value: unknown, index: number) => {
            if (value === null) return null;
            const column = columns[index]?.column;
            if (column === 'has_error' || column === 'is_user_byok') return value === 1n;
            if (column === 'status_code') return Number(value);
            return typeof value === 'bigint' ? value.toString() : value;
          });
        }),
      };
    }
  );
  return { statements, query, insertMetadata };
}

function jsonField(result: SeedResult, key: string): unknown {
  const value = result[key];
  assert.ok(typeof value === 'string');
  return JSON.parse(value);
}

void test('session and since filters are bound with the user before the sentinel limit in either flag order', async t => {
  const { statements } = mockUsageDb(t, []);
  const since = '2026-08-27T10:00:00+02:00';
  for (const args of [
    ['--since', since, '--session-id', ' review-a '],
    ['--session-id', ' review-a ', '--since', since],
  ]) {
    const result = await run(email, ...args);
    assert.ok(result);
    assert.equal(result.sessionId, 'review-a');
    const statement = statements.at(-1);
    assert.ok(statement);
    assert.equal(
      statement.sql.slice(statement.sql.indexOf(' where ')),
      ' where ("microdollar_usage"."kilo_user_id" = $1 and "microdollar_usage"."created_at" > $2 and "microdollar_usage_metadata"."session_id" = $3) order by "microdollar_usage"."created_at" desc limit $4'
    );
    assert.deepEqual(statement.params, [userId, '2026-08-27T08:00:00.000Z', 'review-a', 101]);
  }
});

void test('session filtering applies the default 48-hour window when --since is omitted', async t => {
  const { statements } = mockUsageDb(t, []);
  const result = await run(email, '--session-id', 'isolate-run');
  assert.ok(result);
  assert.equal(result.sessionId, 'isolate-run');
  assert.equal(result.since, '2026-08-25T10:00:00.000Z');
  assert.equal(result.rows, 0);
  const statement = statements.at(-1);
  assert.ok(statement);
  assert.equal(
    statement.sql.slice(statement.sql.indexOf(' where ')),
    ' where ("microdollar_usage"."kilo_user_id" = $1 and "microdollar_usage"."created_at" > $2 and "microdollar_usage_metadata"."session_id" = $3) order by "microdollar_usage"."created_at" desc limit $4'
  );
  assert.deepEqual(statement.params, [userId, '2026-08-25T10:00:00.000Z', 'isolate-run', 101]);
});

for (const { name, sinceArgs, since, includedTimes } of [
  {
    name: 'default 48-hour window',
    sinceArgs: [],
    since: '2026-08-25T10:00:00.000Z',
    includedTimes: ['2026-08-25T10:00:00.001Z', '2026-08-27T09:00:00.000Z'],
  },
  {
    name: 'explicit older --since window',
    sinceArgs: ['--since', '2026-08-24T12:00:00+02:00'],
    since: '2026-08-24T10:00:00.000Z',
    includedTimes: [
      '2026-08-24T10:00:00.001Z',
      '2026-08-25T09:59:59.999Z',
      '2026-08-25T10:00:00.000Z',
      '2026-08-25T10:00:00.001Z',
      '2026-08-27T09:00:00.000Z',
    ],
  },
]) {
  void test(`${name} bounds aggregates, samples and unattributed totals consistently across scopes`, async t => {
    mockUsageDb(
      t,
      [
        { session_id: 'review-a', cost: 2, input_tokens: 20 },
        { session_id: 'child', cost: 3, input_tokens: 30 },
        { session_id: null, cost: 5, input_tokens: 50 },
        { metadataPresent: false, cost: 7, input_tokens: 70 },
        { session_id: 'unrelated', cost: 11, input_tokens: 110 },
        { kilo_user_id: 'other-user', cost: 999999, input_tokens: 999999 },
      ].flatMap(overrides =>
        [
          '2026-08-24 09:59:59.999+00',
          '2026-08-24 10:00:00+00',
          '2026-08-24 10:00:00.001+00',
          '2026-08-25 09:59:59.999+00',
          '2026-08-25 10:00:00+00',
          '2026-08-25 10:00:00.001+00',
          '2026-08-27 09:00:00+00',
        ].map(created_at => usageRow({ ...overrides, created_at }))
      )
    );
    for (const { sessionIds, scope, rowsPerTime, costPerTime } of [
      { sessionIds: [], scope: 'user-window', rowsPerTime: 5, costPerTime: 28 },
      { sessionIds: ['review-a'], scope: 'session', rowsPerTime: 1, costPerTime: 2 },
      { sessionIds: ['review-a', 'child'], scope: 'session-set', rowsPerTime: 2, costPerTime: 5 },
    ]) {
      const result = await run(
        email,
        ...sinceArgs,
        ...sessionIds.flatMap(sessionId => ['--session-id', sessionId])
      );
      assert.ok(result);
      const timeCount = includedTimes.length;
      assert.partialDeepStrictEqual(result, {
        since,
        scope,
        matchedRows: rowsPerTime * timeCount,
        billedMicrodollars: costPerTime * timeCount,
        grossInputTokens: costPerTime * timeCount * 10,
        rows: rowsPerTime * timeCount,
        sampledCostMicrodollars: costPerTime * timeCount,
        sampledInputTokens: costPerTime * timeCount * 10,
        unattributedRows: 2 * timeCount,
        unattributedBilledMicrodollars: 12 * timeCount,
        unattributedGrossInputTokens: 120 * timeCount,
        unattributedMissingMetadataRows: timeCount,
        truncated: false,
        runAccountingCompleteness: 'unproven',
      });
      const samples = jsonField(result, 'sampleRowsJson');
      assert.ok(Array.isArray(samples));
      assert.equal(samples.length, rowsPerTime * timeCount);
      assert.deepEqual([...new Set(samples.map(row => row.createdAt))].sort(), includedTimes);
    }
  });
}

void test('sampled totals include BYOK and non-BYOK rows while preserving flat BYOK evidence', async t => {
  mockUsageDb(t, [
    usageRow({
      model: null,
      has_error: true,
      input_tokens: 10,
      output_tokens: 20,
      cache_write_tokens: 30,
      cache_hit_tokens: 40,
      market_cost: 100,
      is_user_byok: true,
      status_code: 401,
    }),
    usageRow({
      id: 'usage-2',
      cost: 7,
      input_tokens: 1,
      output_tokens: 2,
      cache_write_tokens: 3,
      cache_hit_tokens: 4,
      session_id: 'review-b',
    }),
    usageRow({
      id: 'usage-3',
      cost: 5,
      input_tokens: 4,
      output_tokens: 6,
      cache_write_tokens: 8,
      cache_hit_tokens: 10,
      market_cost: 50,
      is_user_byok: true,
      status_code: 401,
    }),
  ]);
  const result = await run(email);
  assert.ok(result);
  assert.partialDeepStrictEqual(result, {
    userId,
    sessionId: null,
    matchedRows: 3,
    billedMicrodollars: 12,
    marketMicrodollars: 150,
    grossInputTokens: 15,
    outputTokens: 28,
    cacheWriteTokens: 41,
    cacheReadTokens: 54,
    byokTrueRows: 2,
    byokFalseRows: 1,
    byokUnknownRows: 0,
    successRows: 2,
    errorRows: 1,
    missingMetadataRows: 0,
    missingMarketCostRows: 1,
    marketCostCompleteness: 'partial',
    runAccountingCompleteness: 'unproven',
    rows: 3,
    truncated: false,
    sampledCostMicrodollars: 12,
    sampledMarketCostMicrodollars: 150,
    sampledInputTokens: 15,
    sampledOutputTokens: 28,
    sampledCacheWriteTokens: 41,
    sampledCacheHitTokens: 54,
    byokRows: 2,
    nonByokRows: 1,
    latestCreatedAt: '2026-08-27T09:00:00.000Z',
    latestModel: 'requested-model',
    latestProvider: 'provider-a',
    latestIsUserByok: true,
    latestStatusCode: 401,
    latestSessionId: 'review-a',
    byokLatestCreatedAt: '2026-08-27T09:00:00.000Z',
    byokLatestModel: 'requested-model',
    byokLatestProvider: 'provider-a',
    byokLatestSessionId: 'review-a',
    byokSessionIds: 'review-a',
    byokStatusCodes: '401',
    nonByokSessionIds: 'review-b',
  });
  assert.ok(
    Object.values(result).every(
      value => value === null || ['string', 'number', 'boolean'].includes(typeof value)
    )
  );
});

for (const { count, truncated } of [
  { count: 100, truncated: false },
  { count: 101, truncated: true },
]) {
  void test(`${count} matched rows report truncated=${truncated} and exclude the sentinel only from sample evidence`, async t => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      usageRow({
        id: `usage-${index}`,
        cost: index + 1,
        input_tokens: 2 * (index + 1),
        output_tokens: 3 * (index + 1),
        cache_write_tokens: 4 * (index + 1),
        cache_hit_tokens: 5 * (index + 1),
      })
    );
    rows.push(
      usageRow({
        id: 'sentinel',
        created_at: '2026-08-27 08:59:59+00',
        cost: 999999,
        input_tokens: 999999,
        output_tokens: 999999,
        cache_write_tokens: 999999,
        cache_hit_tokens: 999999,
        market_cost: 999999,
        is_user_byok: true,
        session_id: 'sentinel-session',
      })
    );
    mockUsageDb(t, rows.slice(0, count));
    const result = await run(email);
    assert.ok(result);
    assert.equal(result.rows, 100);
    assert.equal(result.truncated, truncated);
    assert.equal(result.sampledCostMicrodollars, 5050);
    assert.equal(result.sampledMarketCostMicrodollars, null);
    assert.equal(result.sampledInputTokens, 10100);
    assert.equal(result.sampledOutputTokens, 15150);
    assert.equal(result.sampledCacheWriteTokens, 20200);
    assert.equal(result.sampledCacheHitTokens, 25250);
    assert.equal(result.byokRows, 0);
    assert.equal(result.nonByokRows, 100);
    assert.equal(result.byokLatestCreatedAt, null);
    assert.equal(result.byokLatestSessionId, null);
    assert.equal(result.byokSessionIds, '');
    assert.equal(result.byokStatusCodes, '');
    assert.equal(result.nonByokSessionIds, 'review-a');
    assert.equal(result.matchedRows, count);
    assert.equal(result.billedMicrodollars, 5050 + (truncated ? 999999 : 0));
    assert.equal(result.marketMicrodollars, truncated ? 999999 : null);
    assert.equal(result.grossInputTokens, 10100 + (truncated ? 999999 : 0));
    assert.equal(result.outputTokens, 15150 + (truncated ? 999999 : 0));
    assert.equal(result.cacheWriteTokens, 20200 + (truncated ? 999999 : 0));
    assert.equal(result.cacheReadTokens, 25250 + (truncated ? 999999 : 0));
    assert.equal(result.byokTrueRows, truncated ? 1 : 0);
    assert.equal(result.runAccountingCompleteness, 'unproven');
  });
}

for (const { name, marketCosts, expected } of [
  { name: 'no rows', marketCosts: [], expected: null },
  { name: 'no market costs', marketCosts: [null, null], expected: null },
  { name: 'a recorded zero market cost', marketCosts: [null, 0], expected: 0 },
]) {
  void test(`sampled market cost handles ${name}`, async t => {
    mockUsageDb(
      t,
      marketCosts.map(market_cost => usageRow({ market_cost }))
    );
    const result = await run(email);
    assert.ok(result);
    assert.equal(result.rows, marketCosts.length);
    assert.equal(result.sessionId, null);
    assert.equal(result.truncated, false);
    assert.equal(result.sampledMarketCostMicrodollars, expected);
    assert.equal(result.marketMicrodollars, expected);
    assert.equal(result.matchedRows, marketCosts.length);
    assert.equal(result.missingMarketCostRows, marketCosts.filter(cost => cost === null).length);
    assert.equal(result.marketCostCompleteness, expected === null ? 'unknown' : 'partial');
    assert.equal(result.runAccountingCompleteness, 'unproven');
    assert.equal(result.sampledCostMicrodollars, 0);
    assert.equal(result.sampledInputTokens, 0);
    assert.equal(result.sampledOutputTokens, 0);
    assert.equal(result.sampledCacheWriteTokens, 0);
    assert.equal(result.sampledCacheHitTokens, 0);
  });
}

void test('repeated session IDs aggregate every matching row across sessions before sampling', async t => {
  const { statements } = mockUsageDb(t, [
    ...Array.from({ length: 150 }, (_, index) =>
      usageRow({
        session_id: index % 2 === 0 ? 'root' : 'child',
        cost: 2,
        market_cost: 1,
        input_tokens: 10,
        output_tokens: 3,
        cache_write_tokens: 2,
        cache_hit_tokens: 4,
      })
    ),
    usageRow({
      created_at: '2026-08-27 08:45:00+00',
      session_id: 'child',
      model: null,
      requested_model: 'failed-model',
      provider: null,
      has_error: true,
      status_code: 500,
      is_user_byok: null,
      cost: 700,
      input_tokens: 20,
      output_tokens: 1,
      cache_write_tokens: 1,
      cache_hit_tokens: 5,
    }),
    usageRow({ session_id: 'unrelated', cost: 999999 }),
    usageRow({ kilo_user_id: 'other-user', session_id: 'root', cost: 999999 }),
    usageRow({ created_at: '2026-08-27 07:59:59+00', session_id: 'root', cost: 999999 }),
  ]);
  const result = await run(
    email,
    '--session-id',
    ' root ',
    '--since',
    '2026-08-27T08:00:00Z',
    '--session-id',
    'child',
    '--session-id',
    'root'
  );
  assert.ok(result);
  assert.partialDeepStrictEqual(result, {
    sessionId: null,
    scope: 'session-set',
    matchedRows: 151,
    billedMicrodollars: 1000,
    marketMicrodollars: 150,
    grossInputTokens: 1520,
    outputTokens: 451,
    cacheWriteTokens: 301,
    cacheReadTokens: 605,
    successRows: 150,
    errorRows: 1,
    byokFalseRows: 150,
    byokUnknownRows: 1,
    missingMarketCostRows: 1,
    inferenceRows: 151,
    classifierRows: 0,
    rows: 100,
    truncated: true,
    sampledCostMicrodollars: 200,
    runAccountingCompleteness: 'unproven',
  });
  assert.deepEqual(jsonField(result, 'sessionIdsJson'), ['root', 'child']);
  assert.deepEqual(jsonField(result, 'observedSessionIdsJson'), ['child', 'root']);
  assert.deepEqual(jsonField(result, 'sessionsWithoutUsageJson'), []);
  const samples = jsonField(result, 'sampleRowsJson');
  assert.ok(Array.isArray(samples));
  assert.equal(samples.length, 100);
  assert.ok(samples.every(row => row.billedMicrodollars === 2 && row.hasError === false));
  const distribution = jsonField(result, 'distributionJson');
  assert.ok(Array.isArray(distribution));
  assert.equal(
    distribution.reduce((total, group) => total + group.rows, 0),
    151
  );
  assert.partialDeepStrictEqual(
    distribution.find(
      group => group.model === 'failed-model' || group.requestedModel === 'failed-model'
    ),
    {
      model: null,
      provider: null,
      requestedModel: 'failed-model',
      statusCode: 500,
      errorRows: 1,
      billedMicrodollars: 700,
    }
  );
  const aggregate = statements[0];
  assert.ok(aggregate);
  assert.match(aggregate.sql, /sum\("microdollar_usage"\."cost"\)/);
  assert.match(aggregate.sql, /"microdollar_usage_metadata"\."session_id" in \(\$3, \$4\)/);
  assert.doesNotMatch(aggregate.sql, / limit /);
  assert.deepEqual(aggregate.params, [userId, '2026-08-27T08:00:00.000Z', 'root', 'child']);
});

void test('BYOK unknown and absent metadata are distinct from known false', async t => {
  mockUsageDb(t, [
    usageRow({ cost: 7, market_cost: 0, is_user_byok: true }),
    usageRow({ cost: 11, session_id: 'review-b', has_error: true, status_code: 500 }),
    usageRow({ cost: 13, market_cost: 20, session_id: 'review-c', is_user_byok: null }),
    usageRow({ id: 'missing-metadata', cost: 17, market_cost: 999, metadataPresent: false }),
    usageRow({ cost: 19, session_id: null }),
  ]);
  const result = await run(email);
  assert.ok(result);
  assert.partialDeepStrictEqual(result, {
    matchedRows: 5,
    billedMicrodollars: 67,
    marketMicrodollars: 20,
    byokTrueRows: 1,
    byokFalseRows: 2,
    byokUnknownRows: 2,
    missingMetadataRows: 1,
    missingMarketCostRows: 3,
    successRows: 4,
    errorRows: 1,
    byokRows: 1,
    nonByokRows: 2,
    unknownByokRows: 2,
    nonByokSessionIds: 'review-b',
    unknownByokSessionIds: 'review-c',
    unattributedRows: 2,
    unattributedBilledMicrodollars: 36,
    unattributedMarketMicrodollars: null,
    unattributedMissingMetadataRows: 1,
    marketCostCompleteness: 'partial',
  });
  const samples = jsonField(result, 'sampleRowsJson');
  assert.ok(Array.isArray(samples));
  assert.partialDeepStrictEqual(
    samples.find(row => row.id === 'missing-metadata'),
    {
      metadataPresent: false,
      isUserByok: null,
      statusCode: null,
      sessionId: null,
      marketMicrodollars: null,
    }
  );
});

void test('delayed metadata stays unattributed until joined, without proving run completeness', async t => {
  const { insertMetadata } = mockUsageDb(t, [
    usageRow({ cost: 3, market_cost: 0 }),
    usageRow({ id: 'delayed', cost: 11, metadataPresent: false }),
    usageRow({ kilo_user_id: 'other-user', cost: 999999, metadataPresent: false }),
    usageRow({ created_at: '2026-08-26 00:00:00+00', cost: 999999, metadataPresent: false }),
    usageRow({ session_id: 'other-session', cost: 999999 }),
  ]);
  const args = [email, '--session-id', 'review-a', '--since', '2026-08-27T08:00:00Z'];
  const before = await run(...args);
  assert.ok(before);
  assert.partialDeepStrictEqual(before, {
    sessionId: 'review-a',
    scope: 'session',
    matchedRows: 1,
    billedMicrodollars: 3,
    marketMicrodollars: 0,
    missingMetadataRows: 0,
    unattributedRows: 1,
    unattributedBilledMicrodollars: 11,
    unattributedMissingMetadataRows: 1,
    marketCostCompleteness: 'complete-for-matched-rows',
    runAccountingCompleteness: 'unproven',
    truncated: false,
  });
  insertMetadata.run('delayed', 0, 200, 'review-a', 17);
  const after = await run(...args);
  assert.ok(after);
  assert.partialDeepStrictEqual(after, {
    matchedRows: 2,
    billedMicrodollars: 14,
    marketMicrodollars: 17,
    missingMetadataRows: 0,
    unattributedRows: 0,
    unattributedBilledMicrodollars: 0,
    runAccountingCompleteness: 'unproven',
    truncated: false,
  });
});

void test('requested sessions without observed usage do not establish a complete session mapping', async t => {
  mockUsageDb(t, [usageRow({ market_cost: 0 })]);
  const result = await run(
    email,
    '--session-id',
    'review-a',
    '--session-id',
    'child-without-usage'
  );
  assert.ok(result);
  assert.equal(result.truncated, false);
  assert.equal(result.matchedRows, 1);
  assert.equal(result.runAccountingCompleteness, 'unproven');
  assert.deepEqual(jsonField(result, 'sessionIdsJson'), ['review-a', 'child-without-usage']);
  assert.deepEqual(jsonField(result, 'observedSessionIdsJson'), ['review-a']);
  assert.deepEqual(jsonField(result, 'sessionsWithoutUsageJson'), ['child-without-usage']);
});

void test('classifier overhead, errored inference and model/provider/status distributions stay separate', async t => {
  mockUsageDb(t, [
    usageRow({
      model: 'qwen/model-a',
      provider: 'provider-a',
      cost: 20,
      market_cost: 40,
      input_tokens: 50,
      output_tokens: 30,
      cache_hit_tokens: 10,
      cache_write_tokens: 5,
    }),
    usageRow({
      session_id: 'child',
      model: null,
      requested_model: 'rejected-model',
      provider: null,
      has_error: true,
      status_code: 429,
      cost: 100,
      input_tokens: 8,
      output_tokens: 1,
      is_user_byok: true,
    }),
    usageRow({
      model: 'auto-routing/classifier',
      requested_model: 'kilo-auto/efficient',
      provider: 'openrouter',
      cost: 5,
    }),
    usageRow({
      session_id: 'child',
      model: 'other/model-b',
      provider: 'provider-b',
      cost: 7,
      market_cost: 0,
      input_tokens: 2,
      is_user_byok: null,
    }),
  ]);
  const result = await run(email, '--session-id', 'review-a', '--session-id', 'child');
  assert.ok(result);
  assert.partialDeepStrictEqual(result, {
    matchedRows: 4,
    billedMicrodollars: 132,
    marketMicrodollars: 40,
    grossInputTokens: 60,
    outputTokens: 31,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    successRows: 3,
    errorRows: 1,
    inferenceRows: 3,
    inferenceBilledMicrodollars: 127,
    inferenceMarketMicrodollars: 40,
    inferenceGrossInputTokens: 60,
    inferenceErrorRows: 1,
    inferenceMissingMarketCostRows: 1,
    classifierRows: 1,
    classifierBilledMicrodollars: 5,
    classifierMarketMicrodollars: null,
    classifierGrossInputTokens: 0,
    classifierErrorRows: 0,
    classifierMissingMarketCostRows: 1,
  });
  const distribution = jsonField(result, 'distributionJson');
  assert.ok(Array.isArray(distribution));
  assert.equal(distribution.length, 4);
  assert.partialDeepStrictEqual(
    distribution.find(group => group.kind === 'classifier'),
    {
      model: 'auto-routing/classifier',
      requestedModel: 'kilo-auto/efficient',
      provider: 'openrouter',
      rows: 1,
      billedMicrodollars: 5,
      statusCode: 200,
      byokFalseRows: 1,
    }
  );
  assert.partialDeepStrictEqual(
    distribution.find(group => group.statusCode === 429),
    {
      model: null,
      requestedModel: 'rejected-model',
      provider: null,
      kind: 'inference',
      rows: 1,
      billedMicrodollars: 100,
      errorRows: 1,
      byokTrueRows: 1,
    }
  );
  assert.partialDeepStrictEqual(
    distribution.find(group => group.provider === 'provider-b'),
    {
      model: 'other/model-b',
      kind: 'inference',
      marketMicrodollars: 0,
      byokUnknownRows: 1,
    }
  );
});

void test('integer cost and token aggregates remain exact beyond the safe JSON number range', async t => {
  mockUsageDb(t, [
    usageRow({
      cost: Number.MAX_SAFE_INTEGER,
      market_cost: Number.MAX_SAFE_INTEGER,
      input_tokens: Number.MAX_SAFE_INTEGER,
    }),
    usageRow({ cost: 2, market_cost: 2, input_tokens: 2 }),
  ]);
  const result = await run(email, '--session-id', 'review-a');
  assert.ok(result);
  assert.partialDeepStrictEqual(result, {
    matchedRows: 2,
    billedMicrodollars: '9007199254740993',
    marketMicrodollars: '9007199254740993',
    grossInputTokens: '9007199254740993',
    sampledCostMicrodollars: '9007199254740993',
    sampledMarketCostMicrodollars: '9007199254740993',
    sampledInputTokens: '9007199254740993',
  });
});

void test('missing, empty and flag-shaped session IDs are rejected before database access', async t => {
  const { query } = mockUsageDb(t, []);
  for (const args of [[], [''], [' \t '], ['--since'], ['--unknown']]) {
    await assert.rejects(run(email, '--session-id', ...args), /--session-id requires a nonempty/);
  }
  assert.equal(query.mock.callCount(), 0);
});

void test('help and missing-email behavior remain database-free', async t => {
  const { query } = mockUsageDb(t, []);
  const log = t.mock.method(console, 'log', () => {});
  assert.equal(await run('--help'), undefined);
  assert.equal(await run('-h'), undefined);
  await assert.rejects(run(), /email is required/);
  assert.ok(log.mock.calls.some(call => String(call.arguments[0]).includes('--session-id <id>')));
  assert.equal(query.mock.callCount(), 0);
});
