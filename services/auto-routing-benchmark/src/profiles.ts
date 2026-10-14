import type {
  BenchmarkConfig,
  BenchmarkPair,
  BenchmarkProfileEntryStatus,
  BenchmarkProfileQuotaError,
  BenchmarkProfileStatus,
  BenchmarkProfileStatusesResponse,
} from '@kilocode/auto-routing-contracts';
import {
  BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH,
  MAX_POOL_ENTRIES,
  benchmarkPairKey,
  estimateMicrodollars,
} from '@kilocode/auto-routing-contracts';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import {
  benchmarkProfiles,
  caseResults,
  profileBenchmarkAdmissions,
  profileBenchmarkClaims,
  profileRequestEvents,
} from './db-schema';
import { DECIDER_CASES } from './datasets/decider-cases';
import {
  allocateProfileAdmission,
  loadActiveProfileClaims,
  recoverProfileAdmission,
  type ProfileCreditBridge,
  type ProfileCreditOwner,
} from './profile-billing';
import { variantFromStorage, variantToStorage } from './reasoning-effort';
import { computeEngineIdentity } from './run';

export const PROFILE_ADMISSION_LIMIT = 10;
export const PROFILE_ADMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MISSING_PROFILE_FAILURE_REASON = 'Benchmark profile missing; retry to request it.';
export const STALE_PROFILE_FAILURE_REASON =
  'Benchmark profile is stale; retry to request a paid current benchmark.';
export type ProfileOwnerType = 'user' | 'org';
export type ProfileRow = typeof benchmarkProfiles.$inferSelect;
export type CurrentProfileContext = { engineIdentity: string; repetitions: number };

export function isCurrentBenchmarkProfile(
  row: Pick<ProfileRow, 'model' | 'variant' | 'engine_identity' | 'repetitions'>,
  current: CurrentProfileContext,
  entry: BenchmarkPair
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

export function classifyProfileAdmission(
  entryRows: readonly ProfileRow[],
  current: CurrentProfileContext,
  entry: BenchmarkPair,
  retry: boolean
): AdmissionClass {
  const row = entryRows.find(candidate => isCurrentBenchmarkProfile(candidate, current, entry));
  if (row) {
    if (row.status !== 'failed') return { kind: 'report', status: row.status };
    if (retry) return { kind: 'admit', charged: true };
    return { kind: 'report', status: 'failed', failureReason: row.failure_reason };
  }
  // Engine drift remains quota-free, but every new measurement requires a credit hold.
  return { kind: 'admit', charged: entryRows.length === 0 };
}

export function computeQuotaRetryAt(oldestInWindowAdmittedAt: string, nowMs = Date.now()): string {
  const oldestMs = Date.parse(oldestInWindowAdmittedAt);
  return new Date(
    (Number.isNaN(oldestMs) ? nowMs : oldestMs) + PROFILE_ADMISSION_WINDOW_MS
  ).toISOString();
}

export function boundFailureReason(reason: string | null | undefined): string | null {
  return reason == null ? null : reason.slice(0, BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH);
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
  constructor(readonly quota: BenchmarkProfileQuotaError) {
    super(quota.error);
    this.name = 'ProfileQuotaExceededError';
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
export class ProfileInsufficientCreditsError extends Error {
  constructor(
    readonly availableCostUsd: number,
    readonly requiredCostUsd: number
  ) {
    super('Insufficient credits to reserve the requested benchmark measurements.');
    this.name = 'ProfileInsufficientCreditsError';
  }
}
export class ProfileAdmissionInProgressError extends Error {
  constructor() {
    super('Benchmark admission is in progress. Retry after its credit reservation is reconciled.');
    this.name = 'ProfileAdmissionInProgressError';
  }
}

function pairKeyFromRow(row: Pick<ProfileRow, 'model' | 'variant'>): string {
  return benchmarkPairKey({ model: row.model, variant: variantFromStorage(row.variant) });
}

async function loadRowsForPairs(
  db: D1Database,
  pairs: readonly BenchmarkPair[]
): Promise<ProfileRow[]> {
  const wanted = new Set(pairs.map(benchmarkPairKey));
  const rows = await drizzle(db)
    .select()
    .from(benchmarkProfiles)
    .where(inArray(benchmarkProfiles.model, [...new Set(pairs.map(pair => pair.model))]));
  return rows.filter(row => wanted.has(pairKeyFromRow(row)));
}

function groupRowsByPair(rows: readonly ProfileRow[]): Map<string, ProfileRow[]> {
  const grouped = new Map<string, ProfileRow[]>();
  for (const row of rows) {
    const key = pairKeyFromRow(row);
    const existing = grouped.get(key);
    if (existing) existing.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function statusFromRow(entry: BenchmarkPair, row: ProfileRow): BenchmarkProfileEntryStatus {
  return {
    entry,
    status: row.status,
    failureReason: row.status === 'failed' ? boundFailureReason(row.failure_reason) : null,
    estimatedCostUsd: 0,
    chargedCostUsd: 0,
  };
}

export function claimUserRequestedStatement(
  orm: DrizzleD1Database,
  pairs: readonly BenchmarkPair[],
  current: CurrentProfileContext,
  nowIso: string
) {
  if (pairs.length === 0) throw new Error('claimUserRequestedStatement requires at least one pair');
  return orm
    .update(benchmarkProfiles)
    .set({ user_requested: true, updated_at: nowIso })
    .where(
      and(
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.user_requested, false),
        sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(
          pairs.map(pair => ({
            model: pair.model,
            variant: variantToStorage(pair.variant),
          }))
        )}) requested
      WHERE json_extract(requested.value, '$.model') = ${benchmarkProfiles.model}
        AND json_extract(requested.value, '$.variant') = ${benchmarkProfiles.variant})`
      )
    );
}

export type EstimateProfilesInput = {
  pairs: readonly BenchmarkPair[];
  retryPairs?: readonly BenchmarkPair[];
  fallbackCaseCostUsd: ReadonlyMap<string, number>;
};

async function planProfiles(
  db: D1Database,
  current: CurrentProfileContext,
  input: EstimateProfilesInput
) {
  assertUniquePairs(input.pairs);
  const wanted = new Set(input.pairs.map(benchmarkPairKey));
  const retryKeys = new Set<string>();
  for (const pair of input.retryPairs ?? []) {
    const key = benchmarkPairKey(pair);
    if (!wanted.has(key)) throw new ProfileValidationError('retryPairs must be a subset of pairs');
    if (retryKeys.has(key)) throw new ProfileValidationError(`Duplicate retry pair: ${key}`);
    retryKeys.add(key);
  }
  const byPair = groupRowsByPair(await loadRowsForPairs(db, input.pairs));
  const plan = input.pairs.map(pair => ({
    pair,
    classification: classifyProfileAdmission(
      byPair.get(benchmarkPairKey(pair)) ?? [],
      current,
      pair,
      retryKeys.has(benchmarkPairKey(pair))
    ),
    estimatedCostUsd: 0,
  }));
  const activeClaims = await loadActiveProfileClaims(
    db,
    plan.filter(item => item.classification.kind === 'admit').map(item => item.pair),
    current
  );
  const activeByPair = new Map(activeClaims.map(claim => [pairKeyFromRow(claim), claim]));
  for (const item of plan) {
    item.estimatedCostUsd = activeByPair.get(benchmarkPairKey(item.pair))?.estimated_cost_usd ?? 0;
  }
  const models = [
    ...new Set(
      plan
        .filter(
          item =>
            item.classification.kind === 'admit' && !activeByPair.has(benchmarkPairKey(item.pair))
        )
        .map(item => item.pair.model)
    ),
  ];
  if (models.length > 0) {
    const historical = await drizzle(db)
      .select({
        model: caseResults.model,
        averageCostUsd: sql<number | null>`AVG(${caseResults.cost_usd})`,
      })
      .from(caseResults)
      .where(and(inArray(caseResults.model, models), gte(caseResults.cost_usd, 0)))
      .groupBy(caseResults.model);
    const historicalByModel = new Map(historical.map(row => [row.model, row.averageCostUsd]));
    for (const item of plan) {
      if (item.classification.kind !== 'admit' || activeByPair.has(benchmarkPairKey(item.pair)))
        continue;
      const historicalCost = historicalByModel.get(item.pair.model);
      const caseCost = historicalCost ?? input.fallbackCaseCostUsd.get(item.pair.model);
      if (caseCost == null || !Number.isFinite(caseCost) || caseCost < 0) {
        throw new ProfileValidationError(
          `No historical cost or valid live catalog pricing for ${item.pair.model}.`
        );
      }
      const total = caseCost * DECIDER_CASES.length * current.repetitions;
      if (!Number.isFinite(total))
        throw new ProfileValidationError(
          `Benchmark estimate is not finite for ${item.pair.model}.`
        );
      item.estimatedCostUsd = estimateMicrodollars(total) / 1_000_000;
    }
  }
  return plan;
}

export async function estimateProfiles(
  db: D1Database,
  config: Pick<BenchmarkConfig, 'deciderRepetitions'>,
  input: EstimateProfilesInput
): Promise<BenchmarkProfileStatusesResponse> {
  const current = currentProfileContextFromConfig(config);
  const plan = await planProfiles(db, current, input);
  const active = await loadActiveProfileClaims(
    db,
    plan.filter(item => item.classification.kind === 'admit').map(item => item.pair),
    current
  );
  if (active.length > 0) throw new ProfileAdmissionInProgressError();
  return {
    statuses: plan.map(
      ({ pair, classification, estimatedCostUsd }): BenchmarkProfileEntryStatus => ({
        entry: pair,
        status: classification.kind === 'report' ? classification.status : 'pending',
        failureReason:
          classification.kind === 'report' && classification.status === 'failed'
            ? boundFailureReason(classification.failureReason)
            : null,
        estimatedCostUsd,
        chargedCostUsd: 0,
      })
    ),
  };
}

export type RegisterProfilesInput = EstimateProfilesInput &
  ProfileCreditOwner & {
    billing: ProfileCreditBridge;
    now?: Date;
  };

export async function registerProfiles(
  db: D1Database,
  config: Pick<BenchmarkConfig, 'deciderRepetitions'>,
  input: RegisterProfilesInput
): Promise<BenchmarkProfileStatusesResponse> {
  const current = currentProfileContextFromConfig(config);
  const now = input.now ?? new Date();
  const plan = await planProfiles(db, current, input);
  const admissions = plan.filter(item => item.classification.kind === 'admit');
  let ownAdmissionId: string | undefined;
  if (admissions.length > 0) {
    const allocation = await allocateProfileAdmission(db, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      engineIdentity: current.engineIdentity,
      repetitions: current.repetitions,
      items: admissions.map(item => ({
        ...item.pair,
        estimatedCostUsd: item.estimatedCostUsd,
        quotaCharged: item.classification.kind === 'admit' && item.classification.charged,
      })),
      admissionLimit: PROFILE_ADMISSION_LIMIT,
      windowStart: new Date(now.getTime() - PROFILE_ADMISSION_WINDOW_MS).toISOString(),
      now: now.toISOString(),
    });
    if (allocation.quotaExceeded) {
      const [oldest] = await drizzle(db)
        .select()
        .from(profileRequestEvents)
        .where(
          and(
            eq(profileRequestEvents.owner_type, input.ownerType),
            eq(profileRequestEvents.owner_id, input.ownerId),
            gte(
              profileRequestEvents.admitted_at,
              new Date(now.getTime() - PROFILE_ADMISSION_WINDOW_MS).toISOString()
            )
          )
        )
        .orderBy(asc(profileRequestEvents.admitted_at))
        .limit(1);
      const retryAt = computeQuotaRetryAt(oldest?.admitted_at ?? now.toISOString(), now.getTime());
      throw new ProfileQuotaExceededError({
        error: `Profile benchmark request limit reached. New benchmarks can be requested after ${retryAt}.`,
        retryAt,
      });
    }
    ownAdmissionId = allocation.admissionId;
    const reservation = await recoverProfileAdmission(
      db,
      input.billing,
      allocation.admissionId,
      now
    );
    if (reservation.kind === 'insufficient') {
      throw new ProfileInsufficientCreditsError(
        reservation.availableCostUsd,
        reservation.requiredCostUsd
      );
    }
  }
  const orm = drizzle(db);
  await claimUserRequestedStatement(orm, input.pairs, current, now.toISOString());
  const statuses = await lookupProfileStatuses(db, config, {
    pairs: input.pairs,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
  });
  const inProgress = await loadActiveProfileClaims(
    db,
    admissions.map(item => item.pair),
    current
  );
  if (
    inProgress.some(claim =>
      statuses.statuses.some(
        status =>
          benchmarkPairKey(status.entry) === pairKeyFromRow(claim) && status.status === 'failed'
      )
    )
  )
    throw new ProfileAdmissionInProgressError();
  const ownClaims = ownAdmissionId
    ? await orm
        .select()
        .from(profileBenchmarkClaims)
        .where(
          and(
            eq(profileBenchmarkClaims.admission_id, ownAdmissionId),
            eq(profileBenchmarkClaims.state, 'admitted')
          )
        )
    : [];
  const ownByPair = new Map(ownClaims.map(claim => [pairKeyFromRow(claim), claim]));
  return {
    statuses: statuses.statuses.map(status => {
      const claim = ownByPair.get(benchmarkPairKey(status.entry));
      return {
        ...status,
        estimatedCostUsd: claim?.estimated_cost_usd ?? 0,
        chargedCostUsd: claim ? claim.charged_cost_usd : 0,
      };
    }),
  };
}

export type LookupProfileStatusesInput = {
  pairs: readonly BenchmarkPair[];
  ownerType?: ProfileOwnerType;
  ownerId?: string;
  now?: Date;
};

export async function lookupProfileStatuses(
  db: D1Database,
  config: Pick<BenchmarkConfig, 'deciderRepetitions'>,
  input: LookupProfileStatusesInput
): Promise<BenchmarkProfileStatusesResponse> {
  assertUniquePairs(input.pairs);
  const current = currentProfileContextFromConfig(config);
  const byPair = groupRowsByPair(await loadRowsForPairs(db, input.pairs));
  const ownerClaims =
    input.ownerType && input.ownerId
      ? await drizzle(db)
          .select({ claim: profileBenchmarkClaims })
          .from(profileBenchmarkClaims)
          .innerJoin(
            profileBenchmarkAdmissions,
            eq(profileBenchmarkClaims.admission_id, profileBenchmarkAdmissions.admission_id)
          )
          .where(
            and(
              eq(profileBenchmarkAdmissions.owner_type, input.ownerType),
              eq(profileBenchmarkAdmissions.owner_id, input.ownerId),
              eq(profileBenchmarkClaims.engine_identity, current.engineIdentity),
              eq(profileBenchmarkClaims.repetitions, current.repetitions),
              inArray(profileBenchmarkClaims.model, [
                ...new Set(input.pairs.map(pair => pair.model)),
              ]),
              inArray(profileBenchmarkClaims.state, ['admitted', 'settled'])
            )
          )
          .orderBy(asc(profileBenchmarkClaims.created_at))
      : [];
  return {
    statuses: input.pairs.map((entry): BenchmarkProfileEntryStatus => {
      const rows = byPair.get(benchmarkPairKey(entry)) ?? [];
      const row = rows.find(candidate => isCurrentBenchmarkProfile(candidate, current, entry));
      if (!row)
        return {
          entry,
          status: 'failed',
          failureReason: rows.length
            ? STALE_PROFILE_FAILURE_REASON
            : MISSING_PROFILE_FAILURE_REASON,
          estimatedCostUsd: 0,
          chargedCostUsd: 0,
        };
      const status = statusFromRow(entry, row);
      const claim = ownerClaims.findLast(
        candidate =>
          pairKeyFromRow(candidate.claim) === benchmarkPairKey(entry) &&
          candidate.claim.run_id === row.run_id
      )?.claim;
      return claim
        ? {
            ...status,
            estimatedCostUsd: claim.estimated_cost_usd,
            chargedCostUsd: claim.charged_cost_usd,
          }
        : status;
    }),
  };
}
