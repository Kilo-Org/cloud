import { DatabaseSync } from 'node:sqlite';
import { getTableColumns } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileFailure } from './profile-failure';
import {
  COPIED_CASE_RESULT_COLUMNS,
  PROFILE_ATTEMPT_SKIP_REASONS,
  caseResultSignature,
  classifyProfileAttempt,
  priorResultSignatures,
  profileAdmissionResetStatement,
  settleProfileRunAttempts,
  splitFreshValidCases,
  type CaseResultRow,
  type ProfileAttemptClassificationInput,
} from './profile-failure-history';
import { caseResults, profileAttemptHistory } from './db-schema';
import { markProfilesReadyForRun, reuseDeciderCaseResults } from './db';
import { PROFILE_FAILURE_BUDGET } from './profile-failure';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-20T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ENGINE = 'engine-test';
const MODEL = 'vendor/model';
const CASE_ID = 'case-a';

const providerDown: ProfileFailure = {
  failureClass: 'provider_unavailable',
  reason: 'Benchmark lane did not finish.',
};

type StoredProfile = {
  status: string;
  failure_class: string | null;
  failure_attempts: number;
  model_failure_attempts: number;
  first_failed_at: string | null;
  retry_after: string | null;
  failure_reason: string | null;
};

function classification(
  overrides: Partial<ProfileAttemptClassificationInput> = {}
): ProfileAttemptClassificationInput {
  return {
    enqueued: true,
    cancelled: false,
    payerFailure: false,
    fenced: false,
    failure: providerDown,
    freshValid: 0,
    copiedValid: 0,
    ...overrides,
  };
}

/** node:sqlite has no boolean binding; these two result columns are boolean|null in D1. */
function sqliteBoolean(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

function row(overrides: Partial<CaseResultRow> = {}): CaseResultRow {
  return {
    run_id: 'run-1',
    model: MODEL,
    variant: '',
    case_id: CASE_ID,
    route_key: null,
    score: 0,
    latency_ms: 10,
    cost_usd: 0.01,
    input_tokens: 5,
    cached_input_tokens: 0,
    output_tokens: 9,
    reasoning_tokens: 0,
    error: null,
    fallback_reason: null,
    route_hit: null,
    retried: null,
    exit_code: 0,
    output_prefix: '{"ok":true}',
    event_count: 3,
    last_event_types: '["done"]',
    tool_calls: 0,
    tool_names: '[]',
    step_count: 1,
    final_finish_reason: 'stop',
    rep: 0,
    timed_out: 0,
    prompt_revision: 2,
    ...overrides,
  };
}

describe('profile attempt classification', () => {
  it('never counts fenced, unattempted or cancelled work', () => {
    expect(classifyProfileAttempt(classification({ fenced: true }))).toEqual({
      kind: 'skip',
      reason: 'fenced',
    });
    expect(classifyProfileAttempt(classification({ enqueued: false }))).toEqual({
      kind: 'skip',
      reason: 'not_attempted',
    });
    expect(classifyProfileAttempt(classification({ cancelled: true }))).toEqual({
      kind: 'skip',
      reason: 'cancelled',
    });
    expect(PROFILE_ATTEMPT_SKIP_REASONS).toEqual([
      'not_attempted',
      'cancelled',
      'payer_failure',
      'fenced',
      'copied_only',
      'not_settled',
    ]);
  });

  it('never counts a paid-admission or payer failure as a model attempt', () => {
    expect(
      classifyProfileAttempt(
        classification({ payerFailure: true, failure: providerDown, freshValid: 0 })
      )
    ).toEqual({ kind: 'skip', reason: 'payer_failure' });
    // Payer failure wins even over a settled failure: no inference was requested.
    expect(classifyProfileAttempt(classification({ payerFailure: true, freshValid: 3 }))).toEqual({
      kind: 'skip',
      reason: 'payer_failure',
    });
  });

  it('treats one newly completed valid case as progress even when the entry still fails', () => {
    expect(
      classifyProfileAttempt(classification({ freshValid: 1, failure: providerDown }))
    ).toEqual({ kind: 'progress', freshValid: 1, copiedValid: 0 });
  });

  it('counts a real failure with no new valid case', () => {
    expect(classifyProfileAttempt(classification({ freshValid: 0 }))).toEqual({
      kind: 'failed',
      failure: providerDown,
      freshValid: 0,
      copiedValid: 0,
    });
  });

  it('does not treat a copied result as progress', () => {
    expect(
      classifyProfileAttempt(classification({ failure: null, freshValid: 0, copiedValid: 3 }))
    ).toEqual({ kind: 'skip', reason: 'copied_only' });
    // A failed entry whose only results were copies is a failed attempt, not progress.
    expect(classifyProfileAttempt(classification({ freshValid: 0, copiedValid: 3 }))).toEqual({
      kind: 'failed',
      failure: providerDown,
      freshValid: 0,
      copiedValid: 3,
    });
  });

  it('records nothing for a run with no result and no failure', () => {
    expect(classifyProfileAttempt(classification({ failure: null }))).toEqual({
      kind: 'skip',
      reason: 'not_settled',
    });
  });
});

describe('stored measurement signatures', () => {
  it('covers every copied case_results column', () => {
    const identity = new Set(['run_id', 'model', 'variant', 'case_id', 'rep']);
    const columns = Object.keys(getTableColumns(caseResults))
      .filter(column => !identity.has(column))
      .sort();
    expect(columns).toEqual([...COPIED_CASE_RESULT_COLUMNS].sort());
  });

  it('treats a valid score of zero as a real measurement, not an error', () => {
    const { freshValid, copiedValid } = splitFreshValidCases([row({ score: 0 })], new Set());
    expect({ freshValid, copiedValid }).toEqual({ freshValid: 1, copiedValid: 0 });
  });

  it('never counts errored, timed-out or unclean-exit rows', () => {
    const rows = [
      row({ case_id: 'e', error: 'boom' }),
      row({ case_id: 't', timed_out: 1 }),
      row({ case_id: 'x', exit_code: 1 }),
    ];
    expect(splitFreshValidCases(rows, new Set())).toEqual({ freshValid: 0, copiedValid: 0 });
  });

  it('recognises an exact copy as copied', () => {
    const original = row({ run_id: 'prior' });
    const copy = row({ run_id: 'current' });
    expect(caseResultSignature(copy)).toBe(caseResultSignature(original));
    expect(splitFreshValidCases([copy], new Set([caseResultSignature(original)]))).toEqual({
      freshValid: 0,
      copiedValid: 1,
    });
  });

  it('treats a re-measured row with a different latency as fresh', () => {
    const original = row({ run_id: 'prior', latency_ms: 10 });
    const fresh = row({ run_id: 'current', latency_ms: 11 });
    expect(splitFreshValidCases([fresh], new Set([caseResultSignature(original)]))).toEqual({
      freshValid: 1,
      copiedValid: 0,
    });
  });
});

describe('profile failure history (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  afterEach(() => sqlite.close());

  function insertRun(runId: string, startedAt: string, status = 'running', router = 'efficient') {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at,
          min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity)
         VALUES (?, ?, 'decider', 'platform', ?, ?, 0.7, 3, 0, ?, ?)`
      )
      .run(runId, router, status, startedAt, 1, ENGINE);
  }

  function claimProfile(
    runId: string,
    options: {
      repetitions?: number;
      router?: string;
      variant?: string;
      model?: string;
      engine?: string;
    } = {}
  ) {
    const repetitions = options.repetitions ?? 1;
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, platform_requested, user_requested)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, 1, 0)
         ON CONFLICT (router, model, variant, engine_identity, repetitions) DO UPDATE SET
           status = 'running', run_id = excluded.run_id, updated_at = excluded.updated_at`
      )
      .run(
        options.router ?? 'efficient',
        options.model ?? MODEL,
        options.variant ?? '',
        options.engine ?? ENGINE,
        repetitions,
        runId,
        iso(T0),
        iso(T0)
      );
  }

  function insertResult(
    runId: string,
    overrides: Partial<CaseResultRow> = {},
    options: { model?: string; variant?: string } = {}
  ) {
    const result = row({ run_id: runId, model: options.model ?? MODEL, ...overrides });
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
          cost_usd, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, error,
          fallback_reason, route_hit, retried, exit_code, output_prefix, event_count,
          last_event_types, tool_calls, tool_names, step_count, final_finish_reason, rep,
          timed_out, prompt_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.run_id,
        result.model,
        options.variant ?? '',
        result.case_id,
        result.route_key,
        result.score,
        result.latency_ms,
        result.cost_usd,
        result.input_tokens,
        result.cached_input_tokens,
        result.output_tokens,
        result.reasoning_tokens,
        result.error,
        result.fallback_reason,
        sqliteBoolean(result.route_hit),
        sqliteBoolean(result.retried),
        result.exit_code,
        result.output_prefix,
        result.event_count,
        result.last_event_types,
        result.tool_calls,
        result.tool_names,
        result.step_count,
        result.final_finish_reason,
        result.rep,
        result.timed_out,
        result.prompt_revision
      );
  }

  function stored(model = MODEL, variant = '', router = 'efficient', repetitions = 1) {
    const profile = sqlite
      .prepare(
        `SELECT status, failure_class, failure_attempts, model_failure_attempts, first_failed_at,
          retry_after, failure_reason FROM benchmark_profiles
         WHERE router = ? AND model = ? AND variant = ? AND engine_identity = ? AND repetitions = ?`
      )
      .get(router, model, variant, ENGINE, repetitions);
    if (!profile) throw new Error('Missing profile row');
    return profile as StoredProfile;
  }

  function attemptCount(model = MODEL, variant = '', router = 'efficient') {
    return Number(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM profile_attempt_history
           WHERE router = ? AND model = ? AND variant = ? AND engine_identity = ?`
        )
        .get(router, model, variant, ENGINE)?.n
    );
  }

  async function settleFailure(
    index: number,
    options: {
      at?: number;
      failure?: ProfileFailure;
      repetitions?: number;
      router?: string;
      variant?: string;
      model?: string;
    } = {}
  ) {
    const at = options.at ?? T0 + index * HOUR;
    const runId = `run-${index}`;
    const repetitions = options.repetitions ?? 1;
    insertRun(runId, iso(at), 'running', options.router ?? 'efficient');
    claimProfile(runId, {
      repetitions,
      router: options.router,
      variant: options.variant,
      model: options.model,
    });
    const failure = options.failure ?? providerDown;
    return settleProfileRunAttempts(db, {
      runId,
      router: (options.router ?? 'efficient') as 'efficient',
      engineIdentity: ENGINE,
      repetitions,
      nowIso: iso(at),
      rows: [],
      attempts: [
        {
          entry: { model: options.model ?? MODEL, variant: options.variant || null },
          failure,
        },
      ],
    });
  }

  it('uses a create-only generated table and never re-diagnoses an existing row', () => {
    const columns = sqlite.prepare('PRAGMA table_info(profile_attempt_history)').all() as {
      name: string;
    }[];
    expect(columns.map(column => column.name)).toEqual(
      Object.keys(getTableColumns(profileAttemptHistory))
    );
    // The generated table has no outcome CHECK: the writer only inserts schema-typed
    // values, so an unexpected write is caught by the types, not the database.
    sqlite
      .prepare(
        `INSERT INTO profile_attempt_history (router, model, variant, engine_identity,
          run_id, repetitions, outcome, attempted_at)
         VALUES ('efficient', 'm', '', ?, 'r', 1, 'progress', ?)`
      )
      .run(ENGINE, iso(T0));
    expect(attemptCount('m')).toBe(1);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, failure_class, failure_attempts, requested_at, updated_at)
         VALUES ('efficient', 'existing/model', '', ?, 1, 'unavailable', 'catalog_absent', 2, ?, ?)`
      )
      .run(ENGINE, iso(T0), iso(T0));
    expect(
      sqlite
        .prepare(
          `SELECT status, failure_class, failure_attempts FROM benchmark_profiles
           WHERE model = 'existing/model'`
        )
        .get()
    ).toEqual({ status: 'unavailable', failure_class: 'catalog_absent', failure_attempts: 2 });
    expect(attemptCount('existing/model')).toBe(0);
  });

  it('counts one attempt per run, across repetition counts, and is permanent above five', async () => {
    const repetitions = [1, 3, 1, 3, 1];
    for (const [index, reps] of repetitions.entries()) {
      const settled = await settleFailure(index, { repetitions: reps });
      expect(settled[0]).toMatchObject({ outcome: 'failed', permanent: false });
      const rowStored = stored(MODEL, '', 'efficient', reps);
      expect(rowStored.status).toBe('failed');
      expect(rowStored.failure_attempts).toBe(index + 1);
    }
    expect(stored(MODEL, '', 'efficient', 1).failure_attempts).toBe(5);

    const sixth = await settleFailure(5, { repetitions: 3 });
    expect(sixth[0]).toMatchObject({ outcome: 'failed', permanent: true });
    const permanent = stored(MODEL, '', 'efficient', 3);
    expect(PROFILE_FAILURE_BUDGET).toBe(6);
    expect(permanent).toMatchObject({
      status: 'unavailable',
      failure_attempts: 6,
      retry_after: null,
    });
    expect(attemptCount()).toBe(6);
  });

  it('counts a redelivered finalization once', async () => {
    await settleFailure(1);
    // Same run id finalized again, as a duplicate consumer would.
    await settleProfileRunAttempts(db, {
      runId: 'run-1',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 2 * HOUR),
      rows: [],
      attempts: [{ entry: { model: MODEL, variant: null }, failure: providerDown }],
    });
    expect(attemptCount()).toBe(1);
    expect(stored('vendor/model', '', 'efficient', 1).failure_attempts).toBe(1);
  });

  it('restarts the streak on a valid score of zero', async () => {
    await settleFailure(1);
    await settleFailure(2);
    expect(stored().failure_attempts).toBe(2);

    insertRun('progress', iso(T0 + 3 * HOUR));
    claimProfile('progress');
    insertResult('progress', { score: 0 });
    const settled = await settleProfileRunAttempts(db, {
      runId: 'progress',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 3 * HOUR),
      rows: [row({ run_id: 'progress', score: 0 })],
      attempts: [{ entry: { model: MODEL, variant: null }, failure: null }],
    });
    expect(settled[0]).toMatchObject({ outcome: 'progress', freshValid: 1, copiedValid: 0 });
    await markProfilesReadyForRun(db, 'progress', iso(T0 + 3 * HOUR));
    expect(stored()).toMatchObject({ status: 'ready', failure_attempts: 0, first_failed_at: null });

    const next = await settleFailure(4, { at: T0 + 4 * HOUR });
    expect(next[0]).toMatchObject({ outcome: 'failed', permanent: false });
    expect(stored().failure_attempts).toBe(1);
  });

  it('keeps the streak through a partially progressed entry that still fails', async () => {
    await settleFailure(1);
    await settleFailure(2);
    insertRun('partial', iso(T0 + 3 * HOUR));
    claimProfile('partial');
    const partial = row({ run_id: 'partial', latency_ms: 99 });
    insertResult('partial', { latency_ms: 99 });
    const settled = await settleProfileRunAttempts(db, {
      runId: 'partial',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 3 * HOUR),
      rows: [partial],
      attempts: [{ entry: { model: MODEL, variant: null }, failure: providerDown }],
    });
    expect(settled[0]).toMatchObject({ outcome: 'progress' });
    expect(stored()).toMatchObject({
      status: 'failed',
      failure_attempts: 0,
      model_failure_attempts: 0,
      first_failed_at: iso(T0 + 3 * HOUR),
      retry_after: iso(T0 + 4 * HOUR),
    });
    const next = await settleFailure(4, { at: T0 + 4 * HOUR });
    expect(next[0]).toMatchObject({ outcome: 'failed' });
    expect(stored().failure_attempts).toBe(1);
  });

  it('never counts a payer failure as an attempt or a model failure', async () => {
    await settleFailure(1);
    insertRun('payer', iso(T0 + 2 * HOUR));
    claimProfile('payer');
    const settled = await settleProfileRunAttempts(db, {
      runId: 'payer',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 2 * HOUR),
      rows: [],
      attempts: [
        {
          entry: { model: MODEL, variant: null },
          payerFailure: true,
          failure: providerDown,
        },
      ],
    });
    expect(settled[0]).toMatchObject({ outcome: 'skip', reason: 'payer_failure' });
    expect(attemptCount()).toBe(1);
    expect(stored().failure_attempts).toBe(1);
  });

  it('does not extend or reset the streak on a fully reused run, a cancel or an omission', async () => {
    await settleFailure(1);
    await settleFailure(2);

    insertRun('prior', iso(T0), 'completed');
    insertResult('prior', { latency_ms: 42 });
    insertRun('reused', iso(T0 + 3 * HOUR));
    claimProfile('reused');
    await reuseDeciderCaseResults(db, {
      runId: 'reused',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      entries: [{ model: MODEL, variant: null }],
      minimumRevisions: {},
    });
    const reused = await settleProfileRunAttempts(db, {
      runId: 'reused',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 3 * HOUR),
      rows: [row({ run_id: 'reused', latency_ms: 42 })],
      attempts: [{ entry: { model: MODEL, variant: null }, failure: null }],
    });
    expect(reused[0]).toMatchObject({ outcome: 'skip', reason: 'copied_only' });
    expect(attemptCount()).toBe(2);
    expect(stored().failure_attempts).toBe(2);

    insertRun('cancelled', iso(T0 + 4 * HOUR));
    claimProfile('cancelled');
    const cancelled = await settleProfileRunAttempts(db, {
      runId: 'cancelled',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 4 * HOUR),
      rows: [],
      attempts: [
        { entry: { model: MODEL, variant: null }, failure: providerDown, cancelled: true },
      ],
    });
    expect(cancelled[0]).toMatchObject({ outcome: 'skip', reason: 'cancelled' });
    expect(attemptCount()).toBe(2);

    insertRun('omitted', iso(T0 + 5 * HOUR));
    await settleProfileRunAttempts(db, {
      runId: 'omitted',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 5 * HOUR),
      rows: [],
      attempts: [
        { entry: { model: MODEL, variant: null }, enqueued: false, failure: providerDown },
      ],
    });
    expect(attemptCount()).toBe(2);

    const next = await settleFailure(6, { at: T0 + 6 * HOUR });
    expect(next[0]).toMatchObject({ outcome: 'failed' });
    expect(stored().failure_attempts).toBe(3);
  });

  it('keeps each router, model, effort and engine streak apart', async () => {
    await settleFailure(1);
    await settleFailure(2);
    expect(stored(MODEL, '', 'efficient', 1).failure_attempts).toBe(2);

    expect((await settleFailure(3, { at: T0 + 3 * HOUR, router: 'frontier' }))[0]).toMatchObject({
      outcome: 'failed',
    });
    expect(stored(MODEL, '', 'frontier', 1).failure_attempts).toBe(1);

    expect(
      (await settleFailure(4, { at: T0 + 4 * HOUR, variant: 'high', repetitions: 1 }))[0]
    ).toMatchObject({ outcome: 'failed' });
    expect(stored(MODEL, 'high', 'efficient', 1).failure_attempts).toBe(1);

    expect((await settleFailure(5, { at: T0 + 5 * HOUR, model: 'vendor/other' }))[0]).toMatchObject(
      { outcome: 'failed' }
    );
    expect(stored('vendor/other', '', 'efficient', 1).failure_attempts).toBe(1);

    insertRun('engine-next', iso(T0 + 6 * HOUR));
    claimProfile('engine-next', { engine: 'engine-next' });
    const engineNext = await settleProfileRunAttempts(db, {
      runId: 'engine-next',
      router: 'efficient',
      engineIdentity: 'engine-next',
      repetitions: 1,
      nowIso: iso(T0 + 6 * HOUR),
      rows: [],
      attempts: [{ entry: { model: MODEL, variant: null }, failure: providerDown }],
    });
    expect(engineNext[0]).toMatchObject({ outcome: 'failed' });
    expect(stored(MODEL, '', 'efficient', 1)).toMatchObject({
      failure_attempts: 2,
      status: 'failed',
    });
    expect(
      Number(
        sqlite
          .prepare(
            `SELECT failure_attempts FROM benchmark_profiles
             WHERE engine_identity = 'engine-next' AND model = ?`
          )
          .get(MODEL)?.failure_attempts
      )
    ).toBe(1);
  });

  it('starts a new streak after an explicit admin re-admission', async () => {
    await settleFailure(1);
    await settleFailure(2);
    await settleFailure(3);
    expect(stored().failure_attempts).toBe(3);

    sqlite
      .prepare(
        `UPDATE benchmark_profiles SET status = 'pending', run_id = NULL, failure_class = NULL,
          failure_reason = NULL, failure_attempts = 0, model_failure_attempts = 0,
          first_failed_at = NULL, retry_after = NULL, requested_at = ?, updated_at = ?
         WHERE model = ?`
      )
      .run(iso(T0 + 4 * HOUR), iso(T0 + 4 * HOUR), MODEL);
    await db.batch([
      profileAdmissionResetStatement(db, {
        router: 'efficient',
        model: MODEL,
        variant: '',
        engineIdentity: ENGINE,
        repetitions: 1,
        admittedAt: iso(T0 + 4 * HOUR),
        requestId: 'readmit-1',
      }),
    ]);

    const settled = await settleFailure(5, { at: T0 + 5 * HOUR });
    expect(settled[0]).toMatchObject({ outcome: 'failed', permanent: false });
    expect(stored().failure_attempts).toBe(1);
  });

  it('keeps the existing terminal diagnoses and never ends a retryable class early', async () => {
    const terminal = await settleFailure(1, {
      failure: { failureClass: 'model_not_found', reason: 'Exact model unavailable.' },
    });
    expect(terminal[0]).toMatchObject({ outcome: 'failed', permanent: true });
    expect(stored()).toMatchObject({
      status: 'unavailable',
      failure_attempts: 1,
      failure_class: 'model_not_found',
    });

    // A model-transient class is not permanent at three attempts: only the sixth proven
    // zero-progress attempt can invalidate it.
    for (const index of [2, 3, 4]) {
      const settled = await settleFailure(index, {
        at: T0 + index * HOUR,
        model: 'vendor/transient',
        failure: providerDown,
      });
      expect(settled[0]).toMatchObject({ outcome: 'failed', permanent: false });
      expect(stored('vendor/transient').status).toBe('failed');
    }
    expect(stored('vendor/transient')).toMatchObject({
      failure_attempts: 3,
      model_failure_attempts: 3,
    });
  });

  it('counts failed attempts inserted out of chronological order', async () => {
    insertRun('late', iso(T0 + 2 * HOUR));
    claimProfile('late');
    const insertAttempt = sqlite.prepare(
      `INSERT INTO profile_attempt_history (router, model, variant, engine_identity, run_id,
        repetitions, outcome, failure_class, failure_reason, attempted_at)
       VALUES ('efficient', ?, '', ?, ?, 1, 'failed', 'provider_unavailable', 'down', ?)`
    );
    insertAttempt.run(MODEL, ENGINE, 'late', iso(T0 + 2 * HOUR));
    insertAttempt.run(MODEL, ENGINE, 'early', iso(T0 + 1 * HOUR));

    await settleProfileRunAttempts(db, {
      runId: 'late',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      nowIso: iso(T0 + 2 * HOUR),
      rows: [],
      attempts: [{ entry: { model: MODEL, variant: null }, failure: providerDown }],
    });
    expect(stored().failure_attempts).toBe(2);
  });

  it('recognises a copied row from local source history', async () => {
    insertRun('source', iso(T0), 'completed');
    insertResult('source', { latency_ms: 7 });
    insertRun('copy', iso(T0 + HOUR));
    await reuseDeciderCaseResults(db, {
      runId: 'copy',
      router: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 1,
      entries: [{ model: MODEL, variant: null }],
      minimumRevisions: {},
    });
    const signatures = await priorResultSignatures(db, {
      runId: 'copy',
      router: 'efficient',
      engineIdentity: ENGINE,
      model: MODEL,
      variant: '',
      slots: [{ caseId: CASE_ID, rep: 0 }],
    });
    expect(signatures.size).toBe(1);
    const copiedRow = sqlite
      .prepare('SELECT * FROM case_results WHERE run_id = ?')
      .get('copy') as unknown as CaseResultRow;
    expect(splitFreshValidCases([copiedRow], signatures)).toEqual({
      freshValid: 0,
      copiedValid: 1,
    });
  });
});
