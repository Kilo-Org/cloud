import type {
  BenchmarkConfig,
  BenchmarkProfileEntryStatus,
  BenchmarkProfileQuotaError,
  BenchmarkProfileStatus,
  BenchmarkProfileStatusesResponse,
  PoolEntry,
} from '@kilocode/auto-routing-contracts';
import {
  BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH,
  MAX_POOL_ENTRIES,
  poolEntryKey,
} from '@kilocode/auto-routing-contracts';
import type { BatchItem } from 'drizzle-orm/batch';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { benchmarkProfiles, profileRequestEvents } from './db-schema';
import { variantFromStorage, variantToStorage } from './reasoning-effort';
import { computeEngineIdentity } from './run';

/** Rolling 24h owner admission limit (charged new/retry only). */
export const PROFILE_ADMISSION_LIMIT = 10;
export const PROFILE_ADMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const MISSING_PROFILE_FAILURE_REASON = 'Benchmark profile missing; retry to request it.';

export type ProfileOwnerType = 'user' | 'org';

export type ProfileRow = typeof benchmarkProfiles.$inferSelect;

export type CurrentProfileContext = {
  engineIdentity: string;
  repetitions: number;
};

/**
 * Shared currency predicate: a profile row is current only when it was measured
 * (or is being measured) under the live decider engine identity and the saved
 * deciderRepetitions, for the same exact Pool entry (model + variant). Used by
 * status lookup and (later) custom table assembly — never treat a stale row as
 * ready.
 */
export function isCurrentBenchmarkProfile(
  row: Pick<ProfileRow, 'model' | 'variant' | 'engine_identity' | 'repetitions'>,
  current: CurrentProfileContext,
  entry: PoolEntry
): boolean {
  return (
    row.model === entry.model &&
    row.variant === variantToStorage(entry.variant) &&
    row.engine_identity === current.engineIdentity &&
    row.repetitions === current.repetitions
  );
}

export function currentProfileContextFromConfig(
  config: Pick<BenchmarkConfig, 'deciderRepetitions'>
): CurrentProfileContext {
  return {
    engineIdentity: computeEngineIdentity('decider'),
    repetitions: config.deciderRepetitions,
  };
}

export type AdmissionClass =
  | { kind: 'report'; status: BenchmarkProfileStatus; failureReason?: string | null }
  | { kind: 'admit'; charged: boolean };

/**
 * Pure classification of one entry against existing registry rows for that
 * exact pair. `retry` is true when the owner listed this entry in retryEntries.
 */
export function classifyProfileAdmission(
  entryRows: readonly ProfileRow[],
  current: CurrentProfileContext,
  entry: PoolEntry,
  retry: boolean
): AdmissionClass {
  const currentRow = entryRows.find(row => isCurrentBenchmarkProfile(row, current, entry));
  if (currentRow) {
    if (
      currentRow.status === 'ready' ||
      currentRow.status === 'pending' ||
      currentRow.status === 'running'
    ) {
      return { kind: 'report', status: currentRow.status };
    }
    // failed
    if (retry) {
      return { kind: 'admit', charged: true };
    }
    return {
      kind: 'report',
      status: 'failed',
      failureReason: currentRow.failure_reason,
    };
  }

  // No current row: stale history (free) or never seen (charged).
  if (entryRows.length > 0) {
    return { kind: 'admit', charged: false };
  }
  return { kind: 'admit', charged: true };
}

export function computeQuotaRetryAt(
  oldestInWindowAdmittedAt: string,
  nowMs: number = Date.now()
): string {
  const oldestMs = Date.parse(oldestInWindowAdmittedAt);
  if (Number.isNaN(oldestMs)) {
    return new Date(nowMs + PROFILE_ADMISSION_WINDOW_MS).toISOString();
  }
  return new Date(oldestMs + PROFILE_ADMISSION_WINDOW_MS).toISOString();
}

export function boundFailureReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  if (reason.length <= BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH) return reason;
  return reason.slice(0, BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH);
}

function assertUniqueEntries(entries: readonly PoolEntry[]): void {
  if (entries.length < 1 || entries.length > MAX_POOL_ENTRIES) {
    throw new ProfileValidationError(
      `entries must contain between 1 and ${MAX_POOL_ENTRIES} unique pool entries`
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = poolEntryKey(entry);
    if (seen.has(key)) {
      throw new ProfileValidationError(`Duplicate pool entry: ${key}`);
    }
    seen.add(key);
  }
}

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

export class ProfileQuotaExceededError extends Error {
  readonly quota: BenchmarkProfileQuotaError;

  constructor(quota: BenchmarkProfileQuotaError) {
    super(quota.error);
    this.name = 'ProfileQuotaExceededError';
    this.quota = quota;
  }
}

export class ProfileConfigMissingError extends Error {
  constructor(
    message = 'benchmark config not set: save it in the admin panel before registering profiles'
  ) {
    super(message);
    this.name = 'ProfileConfigMissingError';
  }
}

function entryKeyFromRow(row: Pick<ProfileRow, 'model' | 'variant'>): string {
  return poolEntryKey({ model: row.model, variant: variantFromStorage(row.variant) });
}

async function loadRowsForEntries(
  db: D1Database,
  entries: readonly PoolEntry[]
): Promise<ProfileRow[]> {
  const models = [...new Set(entries.map(e => e.model))];
  if (models.length === 0) return [];
  const orm = drizzle(db);
  const rows = await orm
    .select()
    .from(benchmarkProfiles)
    .where(inArray(benchmarkProfiles.model, models));
  const wanted = new Set(entries.map(poolEntryKey));
  return rows.filter(row => wanted.has(entryKeyFromRow(row)));
}

function groupRowsByEntry(rows: readonly ProfileRow[]): Map<string, ProfileRow[]> {
  const map = new Map<string, ProfileRow[]>();
  for (const row of rows) {
    const key = entryKeyFromRow(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function statusFromRow(entry: PoolEntry, row: ProfileRow): BenchmarkProfileEntryStatus {
  return {
    entry,
    status: row.status,
    failureReason: row.status === 'failed' ? boundFailureReason(row.failure_reason) : null,
  };
}

function pendingStatus(entry: PoolEntry): BenchmarkProfileEntryStatus {
  return { entry, status: 'pending', failureReason: null };
}

function missingStatus(entry: PoolEntry): BenchmarkProfileEntryStatus {
  return {
    entry,
    status: 'failed',
    failureReason: MISSING_PROFILE_FAILURE_REASON,
  };
}

export function buildPendingUpsertValues(
  entry: PoolEntry,
  current: CurrentProfileContext,
  nowIso: string
): typeof benchmarkProfiles.$inferInsert {
  return {
    model: entry.model,
    variant: variantToStorage(entry.variant),
    engine_identity: current.engineIdentity,
    repetitions: current.repetitions,
    status: 'pending',
    run_id: null,
    failure_reason: null,
    requested_at: nowIso,
    updated_at: nowIso,
    completed_at: null,
  };
}

const PROFILE_PK_TARGET = [
  benchmarkProfiles.model,
  benchmarkProfiles.variant,
  benchmarkProfiles.engine_identity,
  benchmarkProfiles.repetitions,
] as const;

/**
 * Register-path upsert: insert a pending current row, or only transition an
 * existing current row from `failed` → `pending`. Never regresses
 * pending/running/ready or clears their provenance.
 */
export function pendingRegisterUpsertStatement(
  orm: ReturnType<typeof drizzle>,
  values: typeof benchmarkProfiles.$inferInsert
) {
  return orm
    .insert(benchmarkProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: [...PROFILE_PK_TARGET],
      set: {
        status: 'pending',
        run_id: null,
        failure_reason: null,
        requested_at: values.requested_at,
        updated_at: values.updated_at,
        completed_at: null,
      },
      // SQLite ON CONFLICT DO UPDATE WHERE — only rewrite failed rows.
      where: eq(benchmarkProfiles.status, 'failed'),
    });
}

/**
 * Status-lookup free re-admission: insert if absent; on conflict with a
 * concurrently created current row, do nothing (never clobber).
 */
export function pendingStatusInsertStatement(
  orm: ReturnType<typeof drizzle>,
  values: typeof benchmarkProfiles.$inferInsert
) {
  return orm
    .insert(benchmarkProfiles)
    .values(values)
    .onConflictDoNothing({
      target: [...PROFILE_PK_TARGET],
    });
}

export type ChargedEventInsertValues = {
  owner_type: string;
  owner_id: string;
  model: string;
  variant: string;
  engine_identity: string;
  repetitions: number;
  admitted_at: string;
};

/**
 * Charged ledger insert guarded inside the batch: only write an event when no
 * active (pending/running/ready) current profile row exists yet. Statement
 * order places these BEFORE profile upserts so the guard sees pre-batch state
 * within the transaction; SQLite writer serialization makes a concurrent
 * batch's guard observe the first batch's committed row.
 *
 * SQL shape: INSERT ... SELECT NULL AS id, <literals...> WHERE NOT EXISTS (
 *   SELECT 1 FROM benchmark_profiles WHERE pk AND status IN (...))
 *
 * Drizzle's insert().select always emits the full table column list including
 * autoincrement `id`, so the SELECT must provide 8 expressions (NULL AS id)
 * or SQLite/D1 rejects with "7 values for 8 columns".
 */
export function chargedEventInsertStatement(
  orm: ReturnType<typeof drizzle>,
  values: ChargedEventInsertValues
) {
  // __stmt tags the batch item for the in-memory test stand-in; real D1
  // executes the SELECT...WHERE NOT EXISTS guard. Literal SELECT (no FROM)
  // is expressed as SQL because drizzle's typed select builder requires .from().
  return Object.assign(
    orm.insert(profileRequestEvents).select(sql`
      SELECT
        NULL AS id,
        ${values.owner_type} AS owner_type,
        ${values.owner_id} AS owner_id,
        ${values.model} AS model,
        ${values.variant} AS variant,
        ${values.engine_identity} AS engine_identity,
        ${values.repetitions} AS repetitions,
        ${values.admitted_at} AS admitted_at
      WHERE NOT EXISTS (
        SELECT 1 FROM ${benchmarkProfiles}
        WHERE ${benchmarkProfiles.model} = ${values.model}
          AND ${benchmarkProfiles.variant} = ${values.variant}
          AND ${benchmarkProfiles.engine_identity} = ${values.engine_identity}
          AND ${benchmarkProfiles.repetitions} = ${values.repetitions}
          AND ${benchmarkProfiles.status} IN ('pending', 'running', 'ready')
      )
    `),
    {
      __stmt: {
        kind: 'event' as const,
        guarded: true as const,
        values: {
          owner_type: values.owner_type,
          owner_id: values.owner_id,
          model: values.model,
          variant: values.variant,
          engine_identity: values.engine_identity,
          repetitions: values.repetitions,
          admitted_at: values.admitted_at,
        },
      },
    }
  );
}

export type RegisterProfilesInput = {
  ownerType: ProfileOwnerType;
  ownerId: string;
  entries: readonly PoolEntry[];
  retryEntries?: readonly PoolEntry[];
  /** Injectable clock for tests. */
  now?: Date;
};

/**
 * Atomically admit missing/stale/retried Benchmark profiles for an owner.
 * All-or-nothing: either every charged admission + upsert commits in one
 * `db.batch`, or a 429 quota result writes nothing.
 */
export async function registerProfiles(
  db: D1Database,
  config: Pick<BenchmarkConfig, 'deciderRepetitions'>,
  input: RegisterProfilesInput
): Promise<BenchmarkProfileStatusesResponse> {
  assertUniqueEntries(input.entries);
  const current = currentProfileContextFromConfig(config);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const windowStartIso = new Date(now.getTime() - PROFILE_ADMISSION_WINDOW_MS).toISOString();

  const retryKeys = new Set((input.retryEntries ?? []).map(poolEntryKey));
  const existingRows = await loadRowsForEntries(db, input.entries);
  const byEntry = groupRowsByEntry(existingRows);

  type PlanItem = {
    entry: PoolEntry;
    classification: AdmissionClass;
  };
  const plan: PlanItem[] = input.entries.map(entry => ({
    entry,
    classification: classifyProfileAdmission(
      byEntry.get(poolEntryKey(entry)) ?? [],
      current,
      entry,
      retryKeys.has(poolEntryKey(entry))
    ),
  }));

  const chargedAdmissions = plan.filter(
    p => p.classification.kind === 'admit' && p.classification.charged
  );
  const freeAdmissions = plan.filter(
    p => p.classification.kind === 'admit' && !p.classification.charged
  );

  const orm = drizzle(db);
  const recentEvents = await orm
    .select()
    .from(profileRequestEvents)
    .where(
      and(
        eq(profileRequestEvents.owner_type, input.ownerType),
        eq(profileRequestEvents.owner_id, input.ownerId),
        gte(profileRequestEvents.admitted_at, windowStartIso)
      )
    )
    .orderBy(asc(profileRequestEvents.admitted_at));

  if (recentEvents.length + chargedAdmissions.length > PROFILE_ADMISSION_LIMIT) {
    const oldest = recentEvents[0]?.admitted_at ?? nowIso;
    const retryAt = computeQuotaRetryAt(oldest, now.getTime());
    throw new ProfileQuotaExceededError({
      error: `Profile benchmark request limit reached. New benchmarks can be requested after ${retryAt}.`,
      retryAt,
    });
  }

  const admissions = [...chargedAdmissions, ...freeAdmissions];
  if (admissions.length > 0) {
    const stmts: BatchItem<'sqlite'>[] = [];

    // Events first so the NOT EXISTS guard sees pre-batch profile state.
    for (const item of chargedAdmissions) {
      stmts.push(
        chargedEventInsertStatement(orm, {
          owner_type: input.ownerType,
          owner_id: input.ownerId,
          model: item.entry.model,
          variant: variantToStorage(item.entry.variant),
          engine_identity: current.engineIdentity,
          repetitions: current.repetitions,
          admitted_at: nowIso,
        }) as BatchItem<'sqlite'>
      );
    }

    for (const item of admissions) {
      stmts.push(
        pendingRegisterUpsertStatement(
          orm,
          buildPendingUpsertValues(item.entry, current, nowIso)
        ) as BatchItem<'sqlite'>
      );
    }

    // D1 batch requires a non-empty tuple; admissions.length > 0 guarantees it.
    await orm.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  }

  // Derive reported statuses for admitted entries from post-batch rows so a
  // guard-blocked concurrent admit reports the true current status.
  const postRows =
    admissions.length > 0
      ? await loadRowsForEntries(
          db,
          admissions.map(a => a.entry)
        )
      : [];
  const postByEntry = groupRowsByEntry(postRows);

  const statuses: BenchmarkProfileEntryStatus[] = plan.map(({ entry, classification }) => {
    if (classification.kind === 'admit') {
      const currentRow = (postByEntry.get(poolEntryKey(entry)) ?? []).find(row =>
        isCurrentBenchmarkProfile(row, current, entry)
      );
      if (currentRow) return statusFromRow(entry, currentRow);
      return pendingStatus(entry);
    }
    return {
      entry,
      status: classification.status,
      failureReason:
        classification.status === 'failed'
          ? boundFailureReason(classification.failureReason)
          : null,
    };
  });

  return { statuses };
}

export type LookupProfileStatusesInput = {
  entries: readonly PoolEntry[];
  /** Injectable clock for tests. */
  now?: Date;
};

/**
 * Status lookup for up to MAX_POOL_ENTRIES exact pairs.
 * - current row → its status
 * - stale only → free pending insert (no request event; on-conflict do nothing)
 *   + report the actual post-batch current status
 * - missing → failed with missing message; never admits from a read path
 */
export async function lookupProfileStatuses(
  db: D1Database,
  config: Pick<BenchmarkConfig, 'deciderRepetitions'>,
  input: LookupProfileStatusesInput
): Promise<BenchmarkProfileStatusesResponse> {
  assertUniqueEntries(input.entries);
  const current = currentProfileContextFromConfig(config);
  const nowIso = (input.now ?? new Date()).toISOString();

  const existingRows = await loadRowsForEntries(db, input.entries);
  const byEntry = groupRowsByEntry(existingRows);

  const staleToAdmit: PoolEntry[] = [];
  /** Parallel to input.entries: pre-resolved status, or null when stale-admit pending. */
  const preStatuses: Array<BenchmarkProfileEntryStatus | null> = [];

  for (const entry of input.entries) {
    const rows = byEntry.get(poolEntryKey(entry)) ?? [];
    const currentRow = rows.find(row => isCurrentBenchmarkProfile(row, current, entry));
    if (currentRow) {
      preStatuses.push(statusFromRow(entry, currentRow));
      continue;
    }
    if (rows.length > 0) {
      staleToAdmit.push(entry);
      preStatuses.push(null);
      continue;
    }
    preStatuses.push(missingStatus(entry));
  }

  if (staleToAdmit.length > 0) {
    const orm = drizzle(db);
    const stmts = staleToAdmit.map(entry =>
      pendingStatusInsertStatement(orm, buildPendingUpsertValues(entry, current, nowIso))
    );
    await orm.batch(stmts as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  }

  const postRows = staleToAdmit.length > 0 ? await loadRowsForEntries(db, staleToAdmit) : [];
  const postByEntry = groupRowsByEntry(postRows);

  const statuses: BenchmarkProfileEntryStatus[] = input.entries.map((entry, i) => {
    const pre = preStatuses[i];
    if (pre) return pre;
    const currentRow = (postByEntry.get(poolEntryKey(entry)) ?? []).find(row =>
      isCurrentBenchmarkProfile(row, current, entry)
    );
    if (currentRow) return statusFromRow(entry, currentRow);
    return pendingStatus(entry);
  });

  return { statuses };
}
