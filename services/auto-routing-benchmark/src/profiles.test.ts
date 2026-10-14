import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkPair } from '@kilocode/auto-routing-contracts';
import { drizzle } from 'drizzle-orm/d1';
import { benchmarkProfiles, profileRequestEvents } from './db-schema';
import { DECIDER_CASES } from './datasets/decider-cases';
import { recoverPendingProfileAdmissions, type ProfileCreditBridge } from './profile-billing';
import {
  boundFailureReason,
  classifyProfileAdmission,
  computeQuotaRetryAt,
  estimateProfiles,
  isCurrentBenchmarkProfile,
  lookupProfileStatuses,
  MISSING_PROFILE_FAILURE_REASON,
  PROFILE_ADMISSION_WINDOW_MS,
  ProfileAdmissionInProgressError,
  ProfileInsufficientCreditsError,
  ProfileQuotaExceededError,
  ProfileValidationError,
  registerProfiles,
  STALE_PROFILE_FAILURE_REASON,
  type ProfileRow,
} from './profiles';

vi.mock('./run', () => ({ computeEngineIdentity: () => 'current-engine' }));

const SCHEMA_SQL = `
  CREATE TABLE benchmark_profiles (
    model TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL, status TEXT NOT NULL, run_id TEXT, failure_reason TEXT,
    requested_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    platform_requested INTEGER NOT NULL DEFAULT 0, user_requested INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (model, variant, engine_identity, repetitions)
  );
  CREATE TABLE profile_request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
    model TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL, admitted_at TEXT NOT NULL
  );
  CREATE TABLE profile_benchmark_admissions (
    admission_id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
    engine_identity TEXT NOT NULL, repetitions INTEGER NOT NULL, state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE profile_benchmark_claims (
    admission_id TEXT NOT NULL REFERENCES profile_benchmark_admissions(admission_id),
    model TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL, estimated_cost_usd REAL NOT NULL, charged_cost_usd REAL,
    quota_charged INTEGER NOT NULL, state TEXT NOT NULL, terminal_status TEXT, run_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT,
    PRIMARY KEY (admission_id, model, variant)
  );
  CREATE UNIQUE INDEX active_pair ON profile_benchmark_claims
    (model, variant, engine_identity, repetitions)
    WHERE state IN ('allocating', 'admitted') AND terminal_status IS NULL;
  CREATE TABLE case_results (
    run_id TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL, case_id TEXT NOT NULL,
    rep INTEGER NOT NULL DEFAULT 0, cost_usd REAL,
    PRIMARY KEY (run_id, model, variant, case_id, rep)
  );
`;

type SQLiteStatement = {
  bind(...values: unknown[]): SQLiteStatement;
  execute(): { success: boolean; results: Record<string, unknown>[]; meta: { changes: number } };
  all(): Promise<{
    success: boolean;
    results: Record<string, unknown>[];
    meta: { changes: number };
  }>;
  raw(): Promise<unknown[][]>;
  run(): Promise<{
    success: boolean;
    results: Record<string, unknown>[];
    meta: { changes: number };
  }>;
  query: string;
};
type D1Fixture = { db: D1Database; failNextPublication(): void };

function createD1Fixture(sqlite: DatabaseSync): D1Fixture {
  let failPublication = false;
  const adapter = {
    prepare(query: string) {
      let params: unknown[] = [];
      const statement: SQLiteStatement = {
        query,
        bind(...values) {
          params = values;
          return statement;
        },
        execute() {
          const rows = sqlite.prepare(query).all(...(params as never[]));
          const changes = sqlite.prepare('SELECT changes() AS n').get();
          return { success: true, results: rows, meta: { changes: Number(changes?.n ?? 0) } };
        },
        async all() {
          return statement.execute();
        },
        async raw() {
          return statement.execute().results.map(row => Object.values(row));
        },
        async run() {
          return statement.execute();
        },
      };
      return statement;
    },
    async batch(statements: SQLiteStatement[]) {
      sqlite.exec('BEGIN');
      try {
        if (
          failPublication &&
          statements.some(statement => statement.query.includes('insert into "benchmark_profiles"'))
        ) {
          failPublication = false;
          throw new Error('D1 unavailable after reserve');
        }
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    db: adapter as unknown as D1Database,
    failNextPublication() {
      failPublication = true;
    },
  };
}

const NOW = new Date('2026-10-14T12:00:00.000Z');
const config = { deciderRepetitions: 2 };
const current = { engineIdentity: 'current-engine', repetitions: 2 };
const FALLBACK_ESTIMATE_USD =
  Math.ceil(0.01 * DECIDER_CASES.length * config.deciderRepetitions * 1_000_000) / 1_000_000;

function profileRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    model: 'vendor/model',
    variant: '',
    engine_identity: 'current-engine',
    repetitions: 2,
    status: 'ready',
    run_id: 'cached-run',
    failure_reason: null,
    requested_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
    platform_requested: false,
    user_requested: true,
    ...overrides,
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('exact-pair benchmark profiles', () => {
  let sqlite: DatabaseSync;
  let fixture: D1Fixture;
  const reserve = vi.fn<ProfileCreditBridge['reserve']>();
  const settle = vi.fn<ProfileCreditBridge['settle']>();
  const billing: ProfileCreditBridge = { reserve, settle };

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA_SQL);
    fixture = createD1Fixture(sqlite);
    reserve.mockReset().mockResolvedValue({ kind: 'held' });
    settle.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => sqlite.close());

  function registration(
    pairs: BenchmarkPair[],
    ownerId = 'owner-a',
    retryPairs: BenchmarkPair[] = []
  ) {
    return registerProfiles(fixture.db, config, {
      pairs,
      retryPairs,
      ownerType: 'user',
      ownerId,
      billing,
      now: NOW,
      fallbackCaseCostUsd: new Map(pairs.map(pair => [pair.model, 0.01])),
    });
  }

  async function seedProfile(overrides: Partial<ProfileRow> = {}) {
    await drizzle(fixture.db).insert(benchmarkProfiles).values(profileRow(overrides));
  }

  it('matches model, effort, engine and repetitions independently', () => {
    const row = profileRow({ variant: 'high' });
    expect(isCurrentBenchmarkProfile(row, current, { model: row.model, variant: 'high' })).toBe(
      true
    );
    expect(isCurrentBenchmarkProfile(row, current, { model: row.model, variant: 'low' })).toBe(
      false
    );
    expect(
      isCurrentBenchmarkProfile({ ...row, engine_identity: 'old' }, current, {
        model: row.model,
        variant: 'high',
      })
    ).toBe(false);
    expect(
      isCurrentBenchmarkProfile({ ...row, repetitions: 1 }, current, {
        model: row.model,
        variant: 'high',
      })
    ).toBe(false);
  });

  it('reports cached ready/pending/running free without credit or admissions', async () => {
    for (const status of ['ready', 'pending', 'running'] as const) {
      await seedProfile({
        model: `vendor/${status}`,
        status,
        user_requested: false,
        platform_requested: true,
      });
    }
    const pairs = ['ready', 'pending', 'running'].map(status => ({
      model: `vendor/${status}`,
      variant: null,
    }));
    const result = await registration(pairs);
    expect(result.statuses.map(status => status.status)).toEqual(['ready', 'pending', 'running']);
    expect(
      result.statuses.every(status => status.estimatedCostUsd === 0 && status.chargedCostUsd === 0)
    ).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_benchmark_admissions').get()).toEqual({
      n: 0,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 0,
    });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles WHERE user_requested = 1').get()
    ).toEqual({ n: 3 });
  });

  it('quotes every missing effort from historical model average before fallback', async () => {
    sqlite
      .prepare('INSERT INTO case_results VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-1', 'vendor/model', 'low', 'a', 0, 0.02);
    sqlite
      .prepare('INSERT INTO case_results VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-1', 'vendor/model', 'high', 'b', 0, 0.04);
    sqlite
      .prepare('INSERT INTO case_results VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-1', 'vendor/model', 'high', 'c', 0, null);
    const quote = await estimateProfiles(fixture.db, config, {
      pairs: [
        { model: 'vendor/model', variant: 'low' },
        { model: 'vendor/model', variant: 'high' },
      ],
      fallbackCaseCostUsd: new Map(),
    });
    for (const status of quote.statuses) {
      expect(status.estimatedCostUsd).toBeCloseTo(0.03 * DECIDER_CASES.length * 2, 5);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 0 });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('quotes fallback per case times case count and repetitions only when needed', async () => {
    const pair = { model: 'vendor/model', variant: null };
    const quote = await estimateProfiles(fixture.db, config, {
      pairs: [pair],
      fallbackCaseCostUsd: new Map([[pair.model, 0.01]]),
    });
    expect(quote.statuses[0]?.estimatedCostUsd).toBe(FALLBACK_ESTIMATE_USD);
    await expect(
      estimateProfiles(fixture.db, config, { pairs: [pair], fallbackCaseCostUsd: new Map() })
    ).rejects.toThrow(ProfileValidationError);
    await seedProfile();
    await expect(
      estimateProfiles(fixture.db, config, { pairs: [pair], fallbackCaseCostUsd: new Map() })
    ).resolves.toMatchObject({ statuses: [{ estimatedCostUsd: 0 }] });
  });

  it('never admits missing or stale rows from read-only status lookup', async () => {
    await seedProfile({ engine_identity: 'old-engine' });
    const result = await lookupProfileStatuses(fixture.db, config, {
      pairs: [
        { model: 'vendor/model', variant: null },
        { model: 'vendor/missing', variant: null },
      ],
    });
    expect(result.statuses).toMatchObject([
      { status: 'failed', failureReason: STALE_PROFILE_FAILURE_REASON },
      { status: 'failed', failureReason: MISSING_PROFILE_FAILURE_REASON },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_benchmark_claims').get()).toEqual({
      n: 0,
    });
  });

  it('requires paid reserve for engine drift while retaining quota exemption', async () => {
    await seedProfile({ engine_identity: 'old-engine' });
    const result = await registration([{ model: 'vendor/model', variant: null }]);
    expect(reserve).toHaveBeenCalledOnce();
    expect(result.statuses[0]).toMatchObject({
      status: 'pending',
      estimatedCostUsd: FALLBACK_ESTIMATE_USD,
      chargedCostUsd: null,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 0,
    });
    expect(sqlite.prepare('SELECT state FROM profile_benchmark_claims').get()).toEqual({
      state: 'admitted',
    });
  });

  it('reserves the whole won request atomically and insufficient credits leave no runnable row', async () => {
    reserve.mockResolvedValueOnce({
      kind: 'insufficient',
      availableCostUsd: 0.5,
      requiredCostUsd: 2,
    });
    const pairs = [
      { model: 'vendor/model', variant: 'low' },
      { model: 'vendor/model', variant: 'high' },
    ];
    await expect(registration(pairs)).rejects.toThrow(ProfileInsufficientCreditsError);
    expect(reserve.mock.calls[0]?.[0].items).toHaveLength(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 0,
    });
    expect(sqlite.prepare('SELECT state FROM profile_benchmark_admissions').get()).toEqual({
      state: 'insufficient',
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM profile_benchmark_claims WHERE state = 'released'")
        .get()
    ).toEqual({ n: 2 });
    await registration(pairs);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 2 });
  });

  it('serializes concurrent ownership before reserve and reports allocating losers as 409', async () => {
    const started = deferred();
    const finish = deferred();
    reserve.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return { kind: 'held' };
    });
    const pairs = [{ model: 'vendor/model', variant: 'high' }];
    const first = registration(pairs);
    await started.promise;
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 0 });
    await expect(registration(pairs, 'owner-b')).rejects.toThrow(ProfileAdmissionInProgressError);
    expect(reserve).toHaveBeenCalledOnce();
    finish.resolve();
    await expect(first).resolves.toMatchObject({ statuses: [{ status: 'pending' }] });
    const cached = await registration(pairs, 'owner-b');
    expect(cached.statuses[0]).toMatchObject({ estimatedCostUsd: 0, chargedCostUsd: 0 });
    expect(reserve).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 1,
    });
  });

  it('reserves only exact-pair claims won by a partially overlapping request', async () => {
    const started = deferred();
    const finish = deferred();
    reserve.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return { kind: 'held' };
    });
    const shared = { model: 'vendor/model', variant: 'high' };
    const unique = { model: 'vendor/other', variant: null };
    const first = registration([shared]);
    await started.promise;
    await expect(registration([shared, unique], 'owner-b')).rejects.toThrow(
      ProfileAdmissionInProgressError
    );
    expect(reserve.mock.calls[1]?.[0].items).toEqual([
      { ...unique, estimatedCostUsd: FALLBACK_ESTIMATE_USD },
    ]);
    finish.resolve();
    await first;
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 2 });
  });

  it('reconciles crash-after-reserve using the same persisted idempotency request', async () => {
    reserve.mockImplementationOnce(async () => {
      fixture.failNextPublication();
      return { kind: 'held' };
    });
    const pairs = [{ model: 'vendor/model', variant: null }];
    await expect(registration(pairs)).rejects.toThrow('D1 unavailable after reserve');
    expect(sqlite.prepare('SELECT state FROM profile_benchmark_claims').get()).toEqual({
      state: 'allocating',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 0 });
    await recoverPendingProfileAdmissions(fixture.db, billing, NOW);
    expect(reserve.mock.calls[1]?.[0]).toEqual(reserve.mock.calls[0]?.[0]);
    expect(sqlite.prepare('SELECT state FROM profile_benchmark_claims').get()).toEqual({
      state: 'admitted',
    });
    expect(sqlite.prepare('SELECT status FROM benchmark_profiles').get()).toEqual({
      status: 'pending',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 1,
    });
    await recoverPendingProfileAdmissions(fixture.db, billing, NOW);
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a platform winner and retries durable zero-release after a bridge failure', async () => {
    reserve.mockImplementationOnce(async () => {
      await seedProfile({
        status: 'running',
        run_id: 'platform-run',
        platform_requested: true,
        user_requested: false,
      });
      return { kind: 'held' };
    });
    settle.mockRejectedValueOnce(new Error('settlement bridge unavailable'));
    await expect(registration([{ model: 'vendor/model', variant: null }])).rejects.toThrow(
      'settlement bridge unavailable'
    );
    expect(sqlite.prepare('SELECT status, run_id FROM benchmark_profiles').get()).toEqual({
      status: 'running',
      run_id: 'platform-run',
    });
    expect(sqlite.prepare('SELECT state FROM profile_benchmark_claims').get()).toEqual({
      state: 'release_pending',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 0,
    });
    await recoverPendingProfileAdmissions(fixture.db, billing, NOW);
    expect(settle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'vendor/model',
        variant: null,
        runId: null,
        actualCostUsd: 0,
      })
    );
    expect(
      sqlite.prepare('SELECT state, charged_cost_usd FROM profile_benchmark_claims').get()
    ).toEqual({ state: 'released', charged_cost_usd: 0 });
  });

  it('retains the previous unpaid terminal claim when admitting a failed retry with a new hold', async () => {
    const pair = { model: 'vendor/model', variant: 'high' };
    await registration([pair]);
    sqlite.exec(
      "UPDATE benchmark_profiles SET status = 'failed', run_id = 'failed-run', failure_reason = 'boom'; UPDATE profile_benchmark_claims SET run_id = 'failed-run', terminal_status = 'failed', charged_cost_usd = 0;"
    );
    const beforeRetry = await registration([pair]);
    expect(beforeRetry.statuses[0]?.status).toBe('failed');
    expect(reserve).toHaveBeenCalledOnce();
    await registration([pair], 'owner-a', [pair]);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls[1]?.[0].admissionId).not.toBe(reserve.mock.calls[0]?.[0].admissionId);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_benchmark_claims').get()).toEqual({
      n: 2,
    });
    expect(
      sqlite
        .prepare(
          "SELECT state, terminal_status FROM profile_benchmark_claims WHERE run_id = 'failed-run'"
        )
        .get()
    ).toEqual({ state: 'admitted', terminal_status: 'failed' });
    expect(sqlite.prepare('SELECT status, run_id FROM benchmark_profiles').get()).toEqual({
      status: 'pending',
      run_id: null,
    });
  });

  it('counts ten admitted models rather than expanded effort pairs for quota', async () => {
    const pairs = Array.from({ length: 10 }, (_, index) => `vendor/model-${index}`).flatMap(
      model => [
        { model, variant: 'low' },
        { model, variant: 'high' },
      ]
    );
    await registration(pairs);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 10,
    });
    expect(reserve.mock.calls[0]?.[0].items).toHaveLength(20);
    await expect(registration([{ model: 'vendor/eleventh', variant: null }])).rejects.toThrow(
      ProfileQuotaExceededError
    );
    expect(reserve).toHaveBeenCalledOnce();
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM benchmark_profiles WHERE model = 'vendor/eleventh'")
        .get()
    ).toEqual({ n: 0 });
  });

  it('includes allocating model claims in concurrent quota enforcement', async () => {
    for (let index = 0; index < 9; index++) {
      await drizzle(fixture.db)
        .insert(profileRequestEvents)
        .values({
          owner_type: 'user',
          owner_id: 'owner-a',
          model: `old/model-${index}`,
          variant: '',
          engine_identity: 'current-engine',
          repetitions: 2,
          admitted_at: NOW.toISOString(),
        });
    }
    const started = deferred();
    const finish = deferred();
    reserve.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return { kind: 'held' };
    });
    const first = registration([
      { model: 'vendor/tenth', variant: 'low' },
      { model: 'vendor/tenth', variant: 'high' },
    ]);
    await started.promise;
    await expect(registration([{ model: 'vendor/eleventh', variant: null }])).rejects.toThrow(
      ProfileQuotaExceededError
    );
    finish.resolve();
    await first;
    expect(reserve).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 10,
    });
  });

  it('returns actual cost only to the admitting owner while new cached requests remain free', async () => {
    const pair = { model: 'vendor/model', variant: null };
    await registration([pair]);
    sqlite.exec(
      "UPDATE benchmark_profiles SET status = 'ready', run_id = 'paid-run'; UPDATE profile_benchmark_claims SET run_id = 'paid-run', terminal_status = 'ready', charged_cost_usd = 0.12, state = 'settled';"
    );
    const owner = await lookupProfileStatuses(fixture.db, config, {
      pairs: [pair],
      ownerType: 'user',
      ownerId: 'owner-a',
    });
    expect(owner.statuses[0]?.chargedCostUsd).toBe(0.12);
    const other = await lookupProfileStatuses(fixture.db, config, {
      pairs: [pair],
      ownerType: 'user',
      ownerId: 'owner-b',
    });
    expect(other.statuses[0]?.chargedCostUsd).toBe(0);
    expect((await registration([pair], 'owner-b')).statuses[0]?.chargedCostUsd).toBe(0);
    expect(
      (
        await estimateProfiles(fixture.db, config, {
          pairs: [pair],
          fallbackCaseCostUsd: new Map(),
        })
      ).statuses[0]?.estimatedCostUsd
    ).toBe(0);
  });

  it('validates duplicate exact pairs while allowing every variant of one model', async () => {
    const pair = { model: 'vendor/model', variant: null };
    await expect(registration([pair, pair])).rejects.toThrow(ProfileValidationError);
    await expect(
      registration([
        { model: 'vendor/model', variant: 'low' },
        { model: 'vendor/model', variant: 'high' },
      ])
    ).resolves.toMatchObject({ statuses: [{ status: 'pending' }, { status: 'pending' }] });
  });

  it('bounds failures and computes rolling-window retry times', () => {
    expect(boundFailureReason(null)).toBeNull();
    expect(boundFailureReason('x'.repeat(10_000))?.length).toBeLessThan(10_000);
    expect(computeQuotaRetryAt(NOW.toISOString())).toBe(
      new Date(NOW.getTime() + PROFILE_ADMISSION_WINDOW_MS).toISOString()
    );
    expect(
      classifyProfileAdmission(
        [profileRow({ status: 'failed', failure_reason: 'boom' })],
        current,
        { model: 'vendor/model', variant: null },
        false
      )
    ).toEqual({ kind: 'report', status: 'failed', failureReason: 'boom' });
  });
});
