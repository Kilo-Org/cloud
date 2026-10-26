import type {
  AutoRouter,
  BenchmarkConfig,
  BenchmarkProfileEntryStatus,
  BenchmarkProfileQuotaError,
  BenchmarkProfileStatus,
  BenchmarkProfileStatusesResponse,
  BenchmarkPair,
} from '@kilocode/auto-routing-contracts';
import {
  BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH,
  MAX_POOL_ENTRIES,
  benchmarkPairKey,
} from '@kilocode/auto-routing-contracts';
import type { BatchItem } from 'drizzle-orm/batch';
import { and, asc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { benchmarkProfiles, profileRequestEvents } from './db-schema';
import { variantFromStorage, variantToStorage } from './reasoning-effort';
import { computeEngineIdentity } from './run';
import { noLiveBenchmarkChunks } from './profile-entry-claims';

/** Rolling 24h owner admission limit per base router (charged new/retry only). */
export const PROFILE_ADMISSION_LIMIT = 20;
export const PROFILE_ADMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const MISSING_PROFILE_FAILURE_REASON = 'Benchmark profile missing; retry to request it.';

export type ProfileOwnerType = 'user' | 'org';

export type ProfileRow = typeof benchmarkProfiles.$inferSelect;

export type CurrentProfileContext = {
  router?: AutoRouter;
  engineIdentity: string;
  repetitions: number;
};

/**
 * Shared currency predicate: a profile row is current only when it was measured
 * (or is being measured) under the live decider engine identity and the saved
 * deciderRepetitions, for the same exact Pool entry (model + variant). Platform and
 * owner-pool tables require it; custom routers serve an older ready row flagged
 * stale instead (ADR 0005).
 */
export function isCurrentBenchmarkProfile(
  row: Pick<ProfileRow, 'model' | 'variant' | 'engine_identity' | 'repetitions'> & {
    router?: AutoRouter;
  },
  current: CurrentProfileContext,
  entry: BenchmarkPair
): boolean {
  return (
    (row.router ?? 'efficient') === (current.router ?? 'efficient') &&
    row.model === entry.model &&
    row.variant === variantToStorage(entry.variant) &&
    row.engine_identity === current.engineIdentity &&
    row.repetitions === current.repetitions
  );
}

export function currentProfileContextFromConfig(
  config: Pick<BenchmarkConfig, 'deciderRepetitions'> & Partial<Pick<BenchmarkConfig, 'router'>>
): CurrentProfileContext {
  return {
    router: config.router ?? 'efficient',
    engineIdentity: computeEngineIdentity('decider', config.router ?? 'efficient'),
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
  entry: BenchmarkPair,
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

function assertUniquePairs(pairs: readonly BenchmarkPair[]): void {
  if (pairs.length === 0 || new Set(pairs.map(pair => pair.model)).size > MAX_POOL_ENTRIES) {
    throw new ProfileValidationError(
      `pairs must contain at least one exact pair and at most ${MAX_POOL_ENTRIES} models`
    );
  }
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = benchmarkPairKey(pair);
    if (seen.has(key)) throw new ProfileValidationError(`Duplicate benchmark pair: ${key}`);
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
  return benchmarkPairKey({ model: row.model, variant: variantFromStorage(row.variant) });
}

export async function loadProfileRowsForPairs(
  db: D1Database,
  router: AutoRouter,
  pairs: readonly BenchmarkPair[]
): Promise<ProfileRow[]> {
  const models = [...new Set(pairs.map(pair => pair.model))];
  if (models.length === 0) return [];
  const orm = drizzle(db);
  const rows = await orm
    .select()
    .from(benchmarkProfiles)
    .where(and(eq(benchmarkProfiles.router, router), inArray(benchmarkProfiles.model, models)));
  const wanted = new Set(pairs.map(benchmarkPairKey));
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

function statusFromRow(entry: BenchmarkPair, row: ProfileRow): BenchmarkProfileEntryStatus {
  return {
    entry,
    status: row.status,
    failureReason: row.status === 'failed' ? boundFailureReason(row.failure_reason) : null,
  };
}

function pendingStatus(entry: BenchmarkPair): BenchmarkProfileEntryStatus {
  return { entry, status: 'pending', failureReason: null };
}

function missingStatus(entry: BenchmarkPair): BenchmarkProfileEntryStatus {
  return {
    entry,
    status: 'failed',
    failureReason: MISSING_PROFILE_FAILURE_REASON,
  };
}

export function buildPendingUpsertValues(
  entry: BenchmarkPair,
  current: CurrentProfileContext,
  nowIso: string
): typeof benchmarkProfiles.$inferInsert {
  return {
    router: current.router ?? 'efficient',
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
    // An owner asked for this row. The platform flag is left to the platform
    // sync — a row can be wanted by both.
    platform_requested: false,
    user_requested: true,
  };
}

/**
 * Mark every submitted entry as user-requested, whatever its current status.
 *
 * Admission alone is not enough: an entry the platform sync already created is
 * reported (not admitted), so nothing would record that an owner wants it. When
 * the platform list later drops that model its flag is cleared, and the row
 * would fall out of both queues — pending forever, in nobody's queue, and not
 * `failed` so no retry could rescue it.
 */
export function claimUserRequestedStatement(
  orm: ReturnType<typeof drizzle>,
  pairs: readonly BenchmarkPair[],
  current: CurrentProfileContext,
  nowIso: string
) {
  if (pairs.length === 0) {
    throw new Error('claimUserRequestedStatement requires at least one pair');
  }
  // One JSON parameter keeps every expanded pair under D1's bound-variable limit.
  return orm
    .update(benchmarkProfiles)
    .set({ user_requested: true, updated_at: nowIso })
    .where(
      and(
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.user_requested, false),
        sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(
          pairs.map(pair => ({ model: pair.model, variant: variantToStorage(pair.variant) }))
        )}) requested
      WHERE json_extract(requested.value, '$.model') = ${benchmarkProfiles.model}
        AND json_extract(requested.value, '$.variant') = ${benchmarkProfiles.variant})`
      )
    );
}

const PROFILE_PK_TARGET = [
  benchmarkProfiles.router,
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
      where: and(
        eq(benchmarkProfiles.status, 'failed'),
        noLiveBenchmarkChunks({
          router: values.router ?? 'efficient',
          model: values.model,
          variant: values.variant ?? '',
          engineIdentity: values.engine_identity,
          repetitions: values.repetitions,
        })
      ),
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
  router: AutoRouter;
  model: string;
  variant: string;
  engine_identity: string;
  repetitions: number;
  admitted_at: string;
};

/**
 * Charged ledger insert guarded inside the batch: write once per model when any
 * requested charged pair can transition to pending. Events precede upserts so
 * SQLite writer serialization makes concurrent admissions observe committed rows.
 *
 * Drizzle's insert().select always emits the full table column list including
 * autoincrement `id`, so the SELECT must provide 9 expressions (NULL AS id)
 * or SQLite/D1 rejects with "8 values for 9 columns".
 */
export function chargedEventInsertStatement(
  orm: ReturnType<typeof drizzle>,
  values: ChargedEventInsertValues,
  eligiblePairs: readonly BenchmarkPair[] = [
    { model: values.model, variant: variantFromStorage(values.variant) },
  ]
) {
  const eligible = eligiblePairs
    .filter(pair => pair.model === values.model)
    .map(pair => {
      const variant = variantToStorage(pair.variant);
      return sql`(
        NOT EXISTS (
          SELECT 1 FROM ${benchmarkProfiles}
          WHERE ${benchmarkProfiles.model} = ${values.model}
            AND ${benchmarkProfiles.router} = ${values.router}
            AND ${benchmarkProfiles.variant} = ${variant}
            AND ${benchmarkProfiles.engine_identity} = ${values.engine_identity}
            AND ${benchmarkProfiles.repetitions} = ${values.repetitions}
            AND ${benchmarkProfiles.status} IN ('pending', 'running', 'ready')
        )
        AND ${noLiveBenchmarkChunks({
          router: values.router,
          model: values.model,
          variant,
          engineIdentity: values.engine_identity,
          repetitions: values.repetitions,
        })}
      )`;
    });
  // __stmt tags the batch item for the in-memory test stand-in; real D1
  // executes the SELECT...WHERE NOT EXISTS guard. Literal SELECT (no FROM)
  // is expressed as SQL because drizzle's typed select builder requires .from().
  return Object.assign(
    orm.insert(profileRequestEvents).select(sql`
      SELECT
        NULL AS id,
        ${values.owner_type} AS owner_type,
        ${values.owner_id} AS owner_id,
        ${values.router} AS router,
        ${values.model} AS model,
        ${values.variant} AS variant,
        ${values.engine_identity} AS engine_identity,
        ${values.repetitions} AS repetitions,
        ${values.admitted_at} AS admitted_at
      WHERE ${or(...eligible) ?? sql`0`}
    `),
    {
      __stmt: {
        kind: 'event' as const,
        guarded: true as const,
        values: {
          owner_type: values.owner_type,
          owner_id: values.owner_id,
          router: values.router,
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

type ProfileRequestEventRow = typeof profileRequestEvents.$inferSelect;

type AdmissionQuotaScope = {
  ownerType: ProfileOwnerType;
  ownerId: string;
  router: AutoRouter;
  windowStartIso: string;
};

/**
 * Last statement of a charged admission batch. SQLite has no RAISE outside triggers, so
 * it fails the batch with a NOT NULL violation when the batch's own events pushed the
 * rolling count over the limit; D1 then rolls back every write of that batch. Writer
 * serialization makes concurrent admissions count each other's committed events.
 */
function admissionQuotaGuardStatement(orm: DrizzleD1Database, scope: AdmissionQuotaScope) {
  return Object.assign(
    orm.insert(profileRequestEvents).select(sql`
      SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      WHERE (
        SELECT COUNT(*) FROM ${profileRequestEvents}
        WHERE ${profileRequestEvents.owner_type} = ${scope.ownerType}
          AND ${profileRequestEvents.owner_id} = ${scope.ownerId}
          AND ${profileRequestEvents.router} = ${scope.router}
          AND ${profileRequestEvents.admitted_at} >= ${scope.windowStartIso}
      ) > ${PROFILE_ADMISSION_LIMIT}
    `),
    { __stmt: { kind: 'quota_guard' as const } }
  );
}

function recentAdmissionEvents(
  orm: DrizzleD1Database,
  scope: AdmissionQuotaScope
): Promise<ProfileRequestEventRow[]> {
  return orm
    .select()
    .from(profileRequestEvents)
    .where(
      and(
        eq(profileRequestEvents.owner_type, scope.ownerType),
        eq(profileRequestEvents.owner_id, scope.ownerId),
        eq(profileRequestEvents.router, scope.router),
        gte(profileRequestEvents.admitted_at, scope.windowStartIso)
      )
    )
    .orderBy(asc(profileRequestEvents.admitted_at));
}

function profileQuotaExceeded(
  recentEvents: ReadonlyArray<{ admitted_at: string }>,
  now: Date
): ProfileQuotaExceededError {
  const retryAt = computeQuotaRetryAt(
    recentEvents[0]?.admitted_at ?? now.toISOString(),
    now.getTime()
  );
  return new ProfileQuotaExceededError({
    error: `Profile benchmark request limit reached. New benchmarks can be requested after ${retryAt}.`,
    retryAt,
  });
}

export type RegisterProfilesInput = {
  ownerType: ProfileOwnerType;
  ownerId: string;
  /** Every expanded (model, variant) pair of the owner's pool models. */
  pairs: readonly BenchmarkPair[];
  /** Subset of `pairs` the owner explicitly retries after a terminal failure. */
  retryPairs?: readonly BenchmarkPair[];
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
  config: Pick<BenchmarkConfig, 'deciderRepetitions'> & Partial<Pick<BenchmarkConfig, 'router'>>,
  input: RegisterProfilesInput
): Promise<BenchmarkProfileStatusesResponse> {
  assertUniquePairs(input.pairs);
  const current = currentProfileContextFromConfig(config);
  const router = current.router ?? 'efficient';
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const windowStartIso = new Date(now.getTime() - PROFILE_ADMISSION_WINDOW_MS).toISOString();

  const wanted = new Set(input.pairs.map(benchmarkPairKey));
  const retryKeys = new Set<string>();
  for (const pair of input.retryPairs ?? []) {
    const key = benchmarkPairKey(pair);
    if (!wanted.has(key)) throw new ProfileValidationError('retryPairs must be a subset of pairs');
    if (retryKeys.has(key)) throw new ProfileValidationError(`Duplicate retry pair: ${key}`);
    retryKeys.add(key);
  }
  const existingRows = await loadProfileRowsForPairs(db, router, input.pairs);
  const byEntry = groupRowsByEntry(existingRows);

  type PlanItem = {
    entry: BenchmarkPair;
    classification: AdmissionClass;
  };
  const plan: PlanItem[] = input.pairs.map(entry => ({
    entry,
    classification: classifyProfileAdmission(
      byEntry.get(benchmarkPairKey(entry)) ?? [],
      current,
      entry,
      retryKeys.has(benchmarkPairKey(entry))
    ),
  }));

  const chargedAdmissions = plan.filter(
    p => p.classification.kind === 'admit' && p.classification.charged
  );
  const freeAdmissions = plan.filter(
    p => p.classification.kind === 'admit' && !p.classification.charged
  );
  const chargedModels = new Map<string, BenchmarkPair[]>();
  for (const item of chargedAdmissions) {
    const pairs = chargedModels.get(item.entry.model);
    if (pairs) pairs.push(item.entry);
    else chargedModels.set(item.entry.model, [item.entry]);
  }

  const orm = drizzle(db);
  const quotaScope: AdmissionQuotaScope = {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    router,
    windowStartIso,
  };
  const recentEvents = await recentAdmissionEvents(orm, quotaScope);
  if (recentEvents.length + chargedModels.size > PROFILE_ADMISSION_LIMIT) {
    throw profileQuotaExceeded(recentEvents, now);
  }

  const admissions = [...chargedAdmissions, ...freeAdmissions];
  {
    const stmts: BatchItem<'sqlite'>[] = [];

    // Events precede upserts so eligibility is checked against pre-batch state.
    for (const [model, pairs] of chargedModels) {
      stmts.push(
        chargedEventInsertStatement(
          orm,
          {
            owner_type: input.ownerType,
            owner_id: input.ownerId,
            router,
            model,
            variant: variantToStorage(pairs[0]?.variant),
            engine_identity: current.engineIdentity,
            repetitions: current.repetitions,
            admitted_at: nowIso,
          },
          pairs
        )
      );
    }

    for (const item of admissions) {
      stmts.push(
        pendingRegisterUpsertStatement(orm, buildPendingUpsertValues(item.entry, current, nowIso))
      );
    }

    // Runs for reported pairs too, so an existing platform row records that
    // an owner wants it.
    stmts.push(claimUserRequestedStatement(orm, input.pairs, current, nowIso));

    if (chargedModels.size > 0) {
      stmts.push(admissionQuotaGuardStatement(orm, quotaScope));
    }

    try {
      await orm.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    } catch (error) {
      if (chargedModels.size === 0) throw error;
      const committedEvents = await recentAdmissionEvents(orm, quotaScope);
      if (committedEvents.length + chargedModels.size > PROFILE_ADMISSION_LIMIT) {
        throw profileQuotaExceeded(committedEvents, now);
      }
      throw error;
    }
  }

  // Derive reported statuses for admitted entries from post-batch rows so a
  // guard-blocked concurrent admit reports the true current status.
  const postRows =
    admissions.length > 0
      ? await loadProfileRowsForPairs(
          db,
          router,
          admissions.map(a => a.entry)
        )
      : [];
  const postByEntry = groupRowsByEntry(postRows);

  const statuses: BenchmarkProfileEntryStatus[] = plan.map(({ entry, classification }) => {
    if (classification.kind === 'admit') {
      const currentRow = (postByEntry.get(benchmarkPairKey(entry)) ?? []).find(row =>
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
  pairs: readonly BenchmarkPair[];
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
  config: Pick<BenchmarkConfig, 'deciderRepetitions'> & Partial<Pick<BenchmarkConfig, 'router'>>,
  input: LookupProfileStatusesInput
): Promise<BenchmarkProfileStatusesResponse> {
  assertUniquePairs(input.pairs);
  const current = currentProfileContextFromConfig(config);
  const router = current.router ?? 'efficient';
  const nowIso = (input.now ?? new Date()).toISOString();

  const existingRows = await loadProfileRowsForPairs(db, router, input.pairs);
  const byEntry = groupRowsByEntry(existingRows);

  const staleToAdmit: BenchmarkPair[] = [];
  /** Parallel to input.entries: pre-resolved status, or null when stale-admit pending. */
  const preStatuses: Array<BenchmarkProfileEntryStatus | null> = [];

  for (const entry of input.pairs) {
    const rows = byEntry.get(benchmarkPairKey(entry)) ?? [];
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

  const postRows =
    staleToAdmit.length > 0 ? await loadProfileRowsForPairs(db, router, staleToAdmit) : [];
  const postByEntry = groupRowsByEntry(postRows);

  const statuses: BenchmarkProfileEntryStatus[] = input.pairs.map((entry, i) => {
    const pre = preStatuses[i];
    if (pre) return pre;
    const currentRow = (postByEntry.get(benchmarkPairKey(entry)) ?? []).find(row =>
      isCurrentBenchmarkProfile(row, current, entry)
    );
    if (currentRow) return statusFromRow(entry, currentRow);
    return pendingStatus(entry);
  });

  return { statuses };
}
