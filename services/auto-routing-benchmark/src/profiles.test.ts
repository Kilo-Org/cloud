import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolEntry } from '@kilocode/auto-routing-contracts';
import type * as DbSchemaModule from './db-schema';
import type * as DrizzleOrmModule from 'drizzle-orm';
import type { ProfileRow } from './profiles';
import type * as RunModule from './run';

// ---------------------------------------------------------------------------
// In-memory D1/drizzle stand-in for admission + status tests.
// Honestly models ON CONFLICT WHERE (failed-only), onConflictDoNothing,
// INSERT...SELECT...WHERE NOT EXISTS charge guards, and post-batch reads.
// ---------------------------------------------------------------------------

type EventRow = {
  id: number;
  owner_type: string;
  owner_id: string;
  model: string;
  variant: string;
  engine_identity: string;
  repetitions: number;
  admitted_at: string;
};

type PendingStmt =
  | { kind: 'event'; values: Omit<EventRow, 'id'>; guarded: boolean }
  | { kind: 'claim_user_requested'; entries: string[] }
  | {
      kind: 'profile';
      values: ProfileRow;
      onConflict: 'update_if_failed' | 'do_nothing' | 'replace';
    };

const store = vi.hoisted(() => {
  const profiles = new Map<string, ProfileRow>();
  const events: EventRow[] = [];
  let nextEventId = 1;

  function profilePk(row: {
    model: string;
    variant: string;
    engine_identity: string;
    repetitions: number;
  }): string {
    return JSON.stringify([row.model, row.variant, row.engine_identity, row.repetitions]);
  }

  return {
    profiles,
    events,
    nextEventId: () => nextEventId++,
    profilePk,
    reset() {
      profiles.clear();
      events.length = 0;
      nextEventId = 1;
    },
    seedProfile(row: ProfileRow) {
      profiles.set(profilePk(row), { ...row });
    },
    seedEvent(row: Omit<EventRow, 'id'>) {
      events.push({ ...row, id: nextEventId++ });
    },
  };
});

vi.mock('drizzle-orm/d1', () => {
  type WhereClause =
    | { type: 'models'; models: string[] }
    | {
        type: 'events';
        ownerType: string;
        ownerId: string;
        windowStart: string;
      };

  function createSelectBuilder(table: 'profiles' | 'events') {
    let where: WhereClause | null = null;
    let orderAsc = false;

    const builder = {
      from() {
        return builder;
      },
      where(clause: WhereClause) {
        where = clause;
        return builder;
      },
      orderBy() {
        orderAsc = true;
        return builder;
      },
      then(resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) {
        return Promise.resolve(builder.execute()).then(resolve, reject);
      },
      async execute() {
        if (table === 'profiles') {
          const all = [...store.profiles.values()];
          if (where?.type === 'models') {
            const set = new Set(where.models);
            return all.filter(r => set.has(r.model));
          }
          return all;
        }
        let rows = [...store.events];
        if (where && where.type === 'events') {
          const eventWhere = where;
          rows = rows.filter(
            e =>
              e.owner_type === eventWhere.ownerType &&
              e.owner_id === eventWhere.ownerId &&
              e.admitted_at >= eventWhere.windowStart
          );
        }
        if (orderAsc) {
          rows.sort((a, b) => a.admitted_at.localeCompare(b.admitted_at) || a.id - b.id);
        }
        return rows;
      },
    };
    return builder;
  }

  function profileValuesFromRow(row: Record<string, unknown>): ProfileRow {
    return {
      model: String(row.model),
      variant: typeof row.variant === 'string' ? row.variant : '',
      engine_identity: String(row.engine_identity),
      repetitions: Number(row.repetitions),
      status: row.status as ProfileRow['status'],
      run_id: (row.run_id as string | null) ?? null,
      failure_reason: (row.failure_reason as string | null) ?? null,
      requested_at: String(row.requested_at),
      updated_at: String(row.updated_at),
      completed_at: (row.completed_at as string | null) ?? null,
      platform_requested: row.platform_requested === true,
      user_requested: row.user_requested !== false,
    };
  }

  function eventValuesFromRow(row: Record<string, unknown>): Omit<EventRow, 'id'> {
    return {
      owner_type: String(row.owner_type),
      owner_id: String(row.owner_id),
      model: String(row.model),
      variant: typeof row.variant === 'string' ? row.variant : '',
      engine_identity: String(row.engine_identity),
      repetitions: Number(row.repetitions),
      admitted_at: String(row.admitted_at),
    };
  }

  function wrapStmt(stmt: PendingStmt) {
    return Object.assign(Promise.resolve(stmt), { __stmt: stmt });
  }

  function createOrm() {
    return {
      select() {
        return {
          from(table: { _: { name: string } } | unknown) {
            const name =
              table && typeof table === 'object' && '_' in table
                ? String((table as { _: { name: string } })._.name)
                : '';
            const tagged = table as { __tableName?: string };
            if (
              tagged.__tableName === 'profile_request_events' ||
              name.includes('profile_request')
            ) {
              return createSelectBuilder('events');
            }
            return createSelectBuilder('profiles');
          },
        };
      },
      update() {
        const stmt: PendingStmt = { kind: 'claim_user_requested', entries: [] };
        const builder = {
          set() {
            return builder;
          },
          where(clause: unknown) {
            // The claim's WHERE is an and() tree that this mock does not walk,
            // so `entries` stays empty and these tests only prove the statement
            // is issued. What it actually updates is covered for real against
            // SQLite in profiles-sql.test.ts.
            const models = (clause as { models?: string[] } | null)?.models;
            if (models) stmt.entries = models;
            return builder;
          },
          __stmt: stmt,
        };
        return builder;
      },
      insert(table: { __tableName?: string }) {
        const isEvents = table.__tableName === 'profile_request_events';
        return {
          values(values: unknown) {
            const row = values as Record<string, unknown>;
            if (isEvents) {
              const stmt: PendingStmt = {
                kind: 'event',
                values: eventValuesFromRow(row),
                guarded: false,
              };
              return Object.assign(wrapStmt(stmt), {
                async execute() {
                  applyStmt(stmt);
                },
              });
            }
            const profileValues = profileValuesFromRow(row);
            return {
              onConflictDoUpdate(config?: { where?: { type?: string; value?: string } }) {
                // Register path: WHERE status = 'failed'
                const whereFailed =
                  !!config?.where &&
                  (config.where as { type?: string; value?: string }).type === 'eq' &&
                  (config.where as { value?: string }).value === 'failed';
                const stmt: PendingStmt = {
                  kind: 'profile',
                  values: profileValues,
                  onConflict: whereFailed ? 'update_if_failed' : 'replace',
                };
                return wrapStmt(stmt);
              },
              onConflictDoNothing() {
                const stmt: PendingStmt = {
                  kind: 'profile',
                  values: profileValues,
                  onConflict: 'do_nothing',
                };
                return wrapStmt(stmt);
              },
            };
          },
          /**
           * INSERT ... SELECT ... WHERE NOT EXISTS — charged event guard.
           * Production Object.assigns __stmt onto the returned value.
           */
          select(_query: unknown) {
            // Placeholder object; chargedEventInsertStatement Object.assigns __stmt.
            return {};
          },
        };
      },
      async batch(stmts: Array<{ __stmt?: PendingStmt } | PendingStmt>) {
        for (const s of stmts) {
          const stmt = (s as { __stmt?: PendingStmt }).__stmt ?? (s as PendingStmt);
          if (!stmt || typeof stmt !== 'object' || !('kind' in stmt)) {
            throw new Error('batch received untagged statement');
          }
          applyStmt(stmt);
        }
      },
    };
  }

  function hasActiveCurrentProfile(values: {
    model: string;
    variant: string;
    engine_identity: string;
    repetitions: number;
  }): boolean {
    const existing = store.profiles.get(store.profilePk(values));
    return (
      !!existing &&
      (existing.status === 'pending' ||
        existing.status === 'running' ||
        existing.status === 'ready')
    );
  }

  function applyStmt(stmt: PendingStmt) {
    if (stmt.kind === 'claim_user_requested') {
      for (const row of store.profiles.values()) {
        if (stmt.entries.includes(row.model)) row.user_requested = true;
      }
      return;
    }
    if (stmt.kind === 'event') {
      if (stmt.guarded && hasActiveCurrentProfile(stmt.values)) {
        // INSERT...SELECT...WHERE NOT EXISTS → zero rows.
        return;
      }
      store.events.push({ ...stmt.values, id: store.nextEventId() });
      return;
    }

    const pk = store.profilePk(stmt.values);
    const existing = store.profiles.get(pk);
    if (!existing) {
      store.profiles.set(pk, { ...stmt.values });
      return;
    }
    if (stmt.onConflict === 'do_nothing') {
      return;
    }
    if (stmt.onConflict === 'update_if_failed') {
      if (existing.status !== 'failed') {
        // WHERE status = 'failed' not satisfied — leave row intact.
        return;
      }
    }
    store.profiles.set(pk, { ...stmt.values });
  }

  return {
    drizzle: vi.fn(() => createOrm()),
  };
});

// Tag schema tables so the mock can distinguish them.
vi.mock('./db-schema', async importOriginal => {
  const actual = await importOriginal<typeof DbSchemaModule>();
  Object.assign(actual.benchmarkProfiles, { __tableName: 'benchmark_profiles' });
  Object.assign(actual.profileRequestEvents, { __tableName: 'profile_request_events' });
  return actual;
});

// Stabilize engine identity for currency tests that swap only repetitions.
vi.mock('./run', async importOriginal => {
  const actual = await importOriginal<typeof RunModule>();
  return {
    ...actual,
    computeEngineIdentity: vi.fn(() => 'v-test:engine'),
  };
});

// drizzle operators: return plain descriptors the mock can read.
vi.mock('drizzle-orm', async importOriginal => {
  const actual = await importOriginal<typeof DrizzleOrmModule>();
  return {
    ...actual,
    inArray: (_col: unknown, values: string[]) => ({ type: 'models' as const, models: values }),
    and: (...parts: unknown[]) => {
      const asEq = parts.filter(
        (p): p is { type: 'eq'; value: string } =>
          !!p && typeof p === 'object' && (p as { type?: string }).type === 'eq'
      );
      const gtePart = parts.find(
        (p): p is { type: 'gte'; value: string } =>
          !!p && typeof p === 'object' && (p as { type?: string }).type === 'gte'
      );
      if (asEq.length >= 2 && gtePart) {
        return {
          type: 'events' as const,
          ownerType: asEq[0]!.value,
          ownerId: asEq[1]!.value,
          windowStart: gtePart.value,
        };
      }
      return { type: 'and', parts };
    },
    eq: (_col: unknown, value: unknown) => ({ type: 'eq' as const, value: String(value) }),
    gte: (_col: unknown, value: unknown) => ({ type: 'gte' as const, value: String(value) }),
    asc: (col: unknown) => col,
  };
});

import {
  buildPendingUpsertValues,
  chargedEventInsertStatement,
  classifyProfileAdmission,
  computeQuotaRetryAt,
  isCurrentBenchmarkProfile,
  lookupProfileStatuses,
  MISSING_PROFILE_FAILURE_REASON,
  pendingRegisterUpsertStatement,
  pendingStatusInsertStatement,
  PROFILE_ADMISSION_LIMIT,
  PROFILE_ADMISSION_WINDOW_MS,
  ProfileQuotaExceededError,
  registerProfiles,
} from './profiles';
import { variantToStorage } from './reasoning-effort';
import { computeEngineIdentity } from './run';

const ENGINE = 'v-test:engine';
const REPS = 1;
const NOW = new Date('2026-07-28T12:00:00.000Z');

function entry(model: string, variant: string | null = null): PoolEntry {
  return { model, variant };
}

function profileRow(
  partial: Partial<ProfileRow> & Pick<ProfileRow, 'model' | 'status'>
): ProfileRow {
  return {
    variant: '',
    engine_identity: ENGINE,
    repetitions: REPS,
    run_id: null,
    failure_reason: null,
    requested_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    completed_at: null,
    platform_requested: false,
    user_requested: true,
    ...partial,
  };
}

/**
 * Build production admission statements (real builders) and apply them through
 * the mock batch path. Exercises chargedEventInsertStatement /
 * pendingRegisterUpsertStatement / pendingStatusInsertStatement so a missing
 * __stmt tag or broken builder wiring fails these race tests.
 */
async function applyProductionAdmissionBatch(opts: {
  chargedEvents?: Array<{
    ownerType: string;
    ownerId: string;
    entry: PoolEntry;
  }>;
  registerUpserts?: PoolEntry[];
  statusInserts?: PoolEntry[];
  nowIso?: string;
}): Promise<void> {
  const { drizzle } = await import('drizzle-orm/d1');
  const orm = drizzle({} as D1Database);
  const nowIso = opts.nowIso ?? NOW.toISOString();
  const current = { engineIdentity: ENGINE, repetitions: REPS };
  const stmts: Array<{ __stmt?: PendingStmt }> = [];

  for (const ev of opts.chargedEvents ?? []) {
    stmts.push(
      chargedEventInsertStatement(orm, {
        owner_type: ev.ownerType,
        owner_id: ev.ownerId,
        model: ev.entry.model,
        variant: variantToStorage(ev.entry.variant),
        engine_identity: ENGINE,
        repetitions: REPS,
        admitted_at: nowIso,
      }) as { __stmt?: PendingStmt }
    );
  }
  for (const entry of opts.registerUpserts ?? []) {
    stmts.push(
      pendingRegisterUpsertStatement(orm, buildPendingUpsertValues(entry, current, nowIso)) as {
        __stmt?: PendingStmt;
      }
    );
  }
  for (const entry of opts.statusInserts ?? []) {
    stmts.push(
      pendingStatusInsertStatement(orm, buildPendingUpsertValues(entry, current, nowIso)) as {
        __stmt?: PendingStmt;
      }
    );
  }

  await (orm as unknown as { batch: (s: typeof stmts) => Promise<void> }).batch(stmts);
}

const config = { deciderRepetitions: REPS };

beforeEach(() => {
  store.reset();
  vi.mocked(computeEngineIdentity).mockReturnValue(ENGINE);
});

// ---------------------------------------------------------------------------
// Currency predicate
// ---------------------------------------------------------------------------

describe('isCurrentBenchmarkProfile', () => {
  const current = { engineIdentity: ENGINE, repetitions: REPS };
  const e = entry('m/a', 'xhigh');

  it('is current only when engine identity, repetitions, and exact entry match', () => {
    expect(
      isCurrentBenchmarkProfile(
        {
          model: 'm/a',
          variant: 'xhigh',
          engine_identity: ENGINE,
          repetitions: REPS,
        },
        current,
        e
      )
    ).toBe(true);
  });

  it('treats an engine-identity change as stale', () => {
    expect(
      isCurrentBenchmarkProfile(
        {
          model: 'm/a',
          variant: 'xhigh',
          engine_identity: 'v-old:engine',
          repetitions: REPS,
        },
        current,
        e
      )
    ).toBe(false);
  });

  it('treats a repetitions change as stale', () => {
    expect(
      isCurrentBenchmarkProfile(
        {
          model: 'm/a',
          variant: 'xhigh',
          engine_identity: ENGINE,
          repetitions: 3,
        },
        current,
        e
      )
    ).toBe(false);
  });

  it('treats a same-engine/repetitions row of another variant as not current', () => {
    expect(
      isCurrentBenchmarkProfile(
        {
          model: 'm/a',
          variant: 'max',
          engine_identity: ENGINE,
          repetitions: REPS,
        },
        current,
        e
      )
    ).toBe(false);
  });

  it('maps null entry variant to empty storage variant', () => {
    expect(
      isCurrentBenchmarkProfile(
        {
          model: 'm/a',
          variant: '',
          engine_identity: ENGINE,
          repetitions: REPS,
        },
        current,
        entry('m/a', null)
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure admission classification
// ---------------------------------------------------------------------------

describe('classifyProfileAdmission', () => {
  const current = { engineIdentity: ENGINE, repetitions: REPS };
  const e = entry('m');

  it('reports ready/pending/running without admission', () => {
    for (const status of ['ready', 'pending', 'running'] as const) {
      expect(
        classifyProfileAdmission([profileRow({ model: 'm', status })], current, e, false)
      ).toEqual({ kind: 'report', status });
    }
  });

  it('reports failed without charge when not retried', () => {
    expect(
      classifyProfileAdmission(
        [profileRow({ model: 'm', status: 'failed', failure_reason: 'boom' })],
        current,
        e,
        false
      )
    ).toEqual({ kind: 'report', status: 'failed', failureReason: 'boom' });
  });

  it('charges admission for explicit failed retry', () => {
    expect(
      classifyProfileAdmission(
        [profileRow({ model: 'm', status: 'failed', failure_reason: 'boom' })],
        current,
        e,
        true
      )
    ).toEqual({ kind: 'admit', charged: true });
  });

  it('charges for a never-seen pair', () => {
    expect(classifyProfileAdmission([], current, e, false)).toEqual({
      kind: 'admit',
      charged: true,
    });
  });

  it('free-admits when only a stale (old engine) row exists', () => {
    expect(
      classifyProfileAdmission(
        [
          profileRow({
            model: 'm',
            status: 'ready',
            engine_identity: 'v-old:engine',
          }),
        ],
        current,
        e,
        false
      )
    ).toEqual({ kind: 'admit', charged: false });
  });

  it('free-admits when only a stale (old repetitions) row exists', () => {
    expect(
      classifyProfileAdmission(
        [profileRow({ model: 'm', status: 'ready', repetitions: 5 })],
        current,
        e,
        false
      )
    ).toEqual({ kind: 'admit', charged: false });
  });
});

describe('computeQuotaRetryAt', () => {
  it('is oldest in-window event + 24h', () => {
    const oldest = '2026-07-28T01:00:00.000Z';
    expect(computeQuotaRetryAt(oldest)).toBe('2026-07-29T01:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// registerProfiles (atomic admission)
// ---------------------------------------------------------------------------

describe('registerProfiles', () => {
  it('admits a missing pair once; a second owner is not charged', async () => {
    const entries = [entry('openai/gpt-4o', 'xhigh')];

    const first = await registerProfiles({} as D1Database, config, {
      ownerType: 'user',
      ownerId: 'owner-a',
      entries,
      now: NOW,
    });
    expect(first.statuses).toEqual([{ entry: entries[0], status: 'pending', failureReason: null }]);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.owner_id).toBe('owner-a');
    expect(store.profiles.size).toBe(1);

    const second = await registerProfiles({} as D1Database, config, {
      ownerType: 'org',
      ownerId: 'owner-b',
      entries,
      now: NOW,
    });
    expect(second.statuses).toEqual([
      { entry: entries[0], status: 'pending', failureReason: null },
    ]);
    // Second owner sees pending and is not charged.
    expect(store.events).toHaveLength(1);
    expect(store.profiles.size).toBe(1);
  });

  it('blocks a second concurrent charge when the batch observes a committed pending row', async () => {
    const entries = [entry('race/model', 'xhigh')];

    // First owner commits a charged pending admission.
    await registerProfiles({} as D1Database, config, {
      ownerType: 'user',
      ownerId: 'owner-a',
      entries,
      now: NOW,
    });
    expect(store.events).toHaveLength(1);
    const firstRunId = [...store.profiles.values()][0]?.run_id ?? null;

    // Concurrent second batch after a stale pre-read that classified "charge":
    // real builders → event guard + failed-only upsert observe committed pending.
    await applyProductionAdmissionBatch({
      chargedEvents: [{ ownerType: 'org', ownerId: 'owner-b', entry: entries[0]! }],
      registerUpserts: entries,
    });

    expect(store.events).toHaveLength(1);
    const row = [...store.profiles.values()].find(r => r.model === 'race/model');
    expect(row?.status).toBe('pending');
    expect(row?.run_id).toBe(firstRunId);

    // Fresh register after concurrent commit reports true pending, no new charge.
    const second = await registerProfiles({} as D1Database, config, {
      ownerType: 'org',
      ownerId: 'owner-b',
      entries,
      now: NOW,
    });
    expect(second.statuses[0]?.status).toBe('pending');
    expect(store.events).toHaveLength(1);
  });

  it('does not charge ready, pending, or running entries', async () => {
    store.seedProfile(profileRow({ model: 'a/ready', status: 'ready', variant: '' }));
    store.seedProfile(profileRow({ model: 'a/pending', status: 'pending', variant: '' }));
    store.seedProfile(profileRow({ model: 'a/running', status: 'running', variant: '' }));

    const result = await registerProfiles({} as D1Database, config, {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [entry('a/ready'), entry('a/pending'), entry('a/running')],
      now: NOW,
    });

    expect(result.statuses.map(s => s.status)).toEqual(['ready', 'pending', 'running']);
    expect(store.events).toHaveLength(0);
  });

  it('does not regress a running current row when a stale pre-read would admit', async () => {
    store.seedProfile(
      profileRow({
        model: 'live/running',
        status: 'running',
        run_id: 'active-run',
        requested_at: '2026-07-28T10:00:00.000Z',
      })
    );

    // Stale-read batch via real builders: charged event + failed-only upsert.
    await applyProductionAdmissionBatch({
      chargedEvents: [{ ownerType: 'user', ownerId: 'stale-reader', entry: entry('live/running') }],
      registerUpserts: [entry('live/running')],
    });

    const row = store.profiles.get(
      store.profilePk(profileRow({ model: 'live/running', status: 'running' }))
    );
    expect(row?.status).toBe('running');
    expect(row?.run_id).toBe('active-run');
    expect(store.events).toHaveLength(0);

    const result = await registerProfiles({} as D1Database, config, {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [entry('live/running')],
      now: NOW,
    });
    expect(result.statuses[0]?.status).toBe('running');
    expect(store.events).toHaveLength(0);
  });

  it('does not regress a ready current row when a stale pre-read would admit', async () => {
    store.seedProfile(
      profileRow({
        model: 'live/ready',
        status: 'ready',
        run_id: 'done-run',
        completed_at: '2026-07-28T09:00:00.000Z',
      })
    );

    await applyProductionAdmissionBatch({
      registerUpserts: [entry('live/ready')],
    });

    const row = store.profiles.get(
      store.profilePk(profileRow({ model: 'live/ready', status: 'ready' }))
    );
    expect(row?.status).toBe('ready');
    expect(row?.run_id).toBe('done-run');
    expect(row?.completed_at).toBe('2026-07-28T09:00:00.000Z');
  });

  it('reports failed without charge when not in retryEntries', async () => {
    store.seedProfile(
      profileRow({
        model: 'a/fail',
        status: 'failed',
        failure_reason: 'container crash',
      })
    );

    const result = await registerProfiles({} as D1Database, config, {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [entry('a/fail')],
      now: NOW,
    });

    expect(result.statuses).toEqual([
      {
        entry: entry('a/fail'),
        status: 'failed',
        failureReason: 'container crash',
      },
    ]);
    expect(store.events).toHaveLength(0);
    expect(
      store.profiles.get(store.profilePk(profileRow({ model: 'a/fail', status: 'failed' })))?.status
    ).toBe('failed');
  });

  it('charges and resets failed entry when listed in retryEntries', async () => {
    store.seedProfile(
      profileRow({
        model: 'a/fail',
        status: 'failed',
        failure_reason: 'container crash',
        run_id: 'old-run',
      })
    );

    const result = await registerProfiles({} as D1Database, config, {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [entry('a/fail')],
      retryEntries: [entry('a/fail')],
      now: NOW,
    });

    expect(result.statuses[0]?.status).toBe('pending');
    expect(store.events).toHaveLength(1);
    const row = [...store.profiles.values()].find(r => r.model === 'a/fail');
    expect(row).toMatchObject({
      status: 'pending',
      failure_reason: null,
      run_id: null,
      engine_identity: ENGINE,
      repetitions: REPS,
    });
  });

  it('free-admits stale engine rows without a request event and keeps history', async () => {
    const stale = profileRow({
      model: 'stale/m',
      status: 'ready',
      engine_identity: 'v-old:engine',
      completed_at: '2026-01-01T00:00:00.000Z',
    });
    store.seedProfile(stale);

    const result = await registerProfiles({} as D1Database, config, {
      ownerType: 'user',
      ownerId: 'u1',
      entries: [entry('stale/m')],
      now: NOW,
    });

    expect(result.statuses[0]?.status).toBe('pending');
    expect(store.events).toHaveLength(0);
    // Old row preserved.
    expect(store.profiles.get(store.profilePk(stale))?.status).toBe('ready');
    // New current pending row inserted.
    const current = [...store.profiles.values()].find(
      r => r.model === 'stale/m' && r.engine_identity === ENGINE
    );
    expect(current?.status).toBe('pending');
  });

  it('allows 10 charged admissions in 24h and rejects the 11th with nothing written', async () => {
    const owner = { ownerType: 'user' as const, ownerId: 'quota-user' };
    // Seed 10 prior charged events in the window.
    for (let i = 0; i < PROFILE_ADMISSION_LIMIT; i++) {
      store.seedEvent({
        owner_type: owner.ownerType,
        owner_id: owner.ownerId,
        model: `prior/${i}`,
        variant: '',
        engine_identity: ENGINE,
        repetitions: REPS,
        admitted_at: new Date(NOW.getTime() - (PROFILE_ADMISSION_LIMIT - i) * 60_000).toISOString(),
      });
    }
    const oldest = store.events[0]!.admitted_at;
    const expectedRetryAt = new Date(
      Date.parse(oldest) + PROFILE_ADMISSION_WINDOW_MS
    ).toISOString();

    const profilesBefore = store.profiles.size;
    const eventsBefore = store.events.length;

    await expect(
      registerProfiles({} as D1Database, config, {
        ...owner,
        entries: [entry('over/quota')],
        now: NOW,
      })
    ).rejects.toBeInstanceOf(ProfileQuotaExceededError);

    try {
      await registerProfiles({} as D1Database, config, {
        ...owner,
        entries: [entry('over/quota')],
        now: NOW,
      });
    } catch (err) {
      const quotaErr = err as ProfileQuotaExceededError;
      expect(quotaErr.quota.retryAt).toBe(expectedRetryAt);
      expect(quotaErr.quota.error).toContain(expectedRetryAt);
    }

    // All-or-nothing: no new events, no profile upsert.
    expect(store.events).toHaveLength(eventsBefore);
    expect(store.profiles.size).toBe(profilesBefore);
    expect([...store.profiles.keys()].some(k => k.includes('over/quota'))).toBe(false);

    // After the retryAt instant, admission succeeds.
    const after = new Date(Date.parse(expectedRetryAt) + 1);
    const result = await registerProfiles({} as D1Database, config, {
      ...owner,
      entries: [entry('over/quota')],
      now: after,
    });
    expect(result.statuses[0]?.status).toBe('pending');
    expect(store.events.some(e => e.model === 'over/quota')).toBe(true);
  });

  it('rejects the whole batch when any charged admission would exceed quota', async () => {
    const owner = { ownerType: 'user' as const, ownerId: 'batch-quota' };
    for (let i = 0; i < 9; i++) {
      store.seedEvent({
        owner_type: owner.ownerType,
        owner_id: owner.ownerId,
        model: `prior/${i}`,
        variant: '',
        engine_identity: ENGINE,
        repetitions: REPS,
        admitted_at: new Date(NOW.getTime() - 60_000).toISOString(),
      });
    }
    // 9 existing + 2 new charged = 11 → reject both, write nothing.
    await expect(
      registerProfiles({} as D1Database, config, {
        ...owner,
        entries: [entry('new/a'), entry('new/b')],
        now: NOW,
      })
    ).rejects.toBeInstanceOf(ProfileQuotaExceededError);

    expect(store.profiles.size).toBe(0);
    expect(store.events).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// lookupProfileStatuses
// ---------------------------------------------------------------------------

describe('lookupProfileStatuses', () => {
  it('returns current statuses without charging', async () => {
    store.seedProfile(profileRow({ model: 'a/ready', status: 'ready' }));
    store.seedProfile(profileRow({ model: 'a/fail', status: 'failed', failure_reason: 'nope' }));

    const result = await lookupProfileStatuses({} as D1Database, config, {
      entries: [entry('a/ready'), entry('a/fail')],
      now: NOW,
    });

    expect(result.statuses).toEqual([
      { entry: entry('a/ready'), status: 'ready', failureReason: null },
      { entry: entry('a/fail'), status: 'failed', failureReason: 'nope' },
    ]);
    expect(store.events).toHaveLength(0);
  });

  it('inserts a free pending row for stale profiles and reports pending', async () => {
    const stale = profileRow({
      model: 'stale/m',
      status: 'ready',
      engine_identity: 'v-old:engine',
    });
    store.seedProfile(stale);

    const result = await lookupProfileStatuses({} as D1Database, config, {
      entries: [entry('stale/m')],
      now: NOW,
    });

    expect(result.statuses[0]).toEqual({
      entry: entry('stale/m'),
      status: 'pending',
      failureReason: null,
    });
    expect(store.events).toHaveLength(0);
    expect(store.profiles.get(store.profilePk(stale))?.status).toBe('ready');
    const current = [...store.profiles.values()].find(
      r => r.model === 'stale/m' && r.engine_identity === ENGINE
    );
    expect(current?.status).toBe('pending');
  });

  it('preserves a concurrent current row on stale status-lookup insert race', async () => {
    const stale = profileRow({
      model: 'race/stale',
      status: 'ready',
      engine_identity: 'v-old:engine',
    });
    store.seedProfile(stale);
    // Concurrent writer already created the current ready row.
    store.seedProfile(
      profileRow({
        model: 'race/stale',
        status: 'ready',
        run_id: 'winner-run',
        completed_at: '2026-07-28T08:00:00.000Z',
      })
    );

    // Lookup sees current ready → reports it, no charge.
    const withCurrent = await lookupProfileStatuses({} as D1Database, config, {
      entries: [entry('race/stale')],
      now: NOW,
    });
    expect(withCurrent.statuses[0]?.status).toBe('ready');
    expect(
      store.profiles.get(
        store.profilePk(profileRow({ model: 'race/stale', status: 'ready', run_id: 'winner-run' }))
      )?.run_id
    ).toBe('winner-run');

    // Explicit do_nothing race via real status builder: must not clobber ready.
    await applyProductionAdmissionBatch({
      statusInserts: [entry('race/stale')],
    });
    const current = store.profiles.get(
      store.profilePk(profileRow({ model: 'race/stale', status: 'ready' }))
    );
    expect(current?.status).toBe('ready');
    expect(current?.run_id).toBe('winner-run');
    expect(store.events).toHaveLength(0);
  });

  it('reports missing as failed without admitting', async () => {
    const result = await lookupProfileStatuses({} as D1Database, config, {
      entries: [entry('never/seen')],
      now: NOW,
    });

    expect(result.statuses).toEqual([
      {
        entry: entry('never/seen'),
        status: 'failed',
        failureReason: MISSING_PROFILE_FAILURE_REASON,
      },
    ]);
    expect(store.profiles.size).toBe(0);
    expect(store.events).toHaveLength(0);
  });
});
