import type { BenchmarkPair } from '@kilocode/auto-routing-contracts';
import { benchmarkPairKey, estimateMicrodollars } from '@kilocode/auto-routing-contracts';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import {
  benchmarkProfiles,
  profileBenchmarkAdmissions,
  profileBenchmarkClaims,
  profileRequestEvents,
} from './db-schema';
import { variantFromStorage, variantToStorage } from './reasoning-effort';

export type ProfileCreditOwner = { ownerType: 'user' | 'org'; ownerId: string };
export type ProfileCreditItem = BenchmarkPair & { estimatedCostUsd: number };
export type ProfileCreditReserveRequest = ProfileCreditOwner & {
  admissionId: string;
  items: readonly ProfileCreditItem[];
};
export type ProfileCreditSettleRequest = ProfileCreditOwner &
  BenchmarkPair & {
    admissionId: string;
    runId: string | null;
    actualCostUsd: number;
  };
export type ProfileCreditReserveResult =
  | { kind: 'held' }
  | { kind: 'insufficient'; availableCostUsd: number; requiredCostUsd: number };
export type ProfileCreditBridge = {
  reserve(request: ProfileCreditReserveRequest): Promise<ProfileCreditReserveResult>;
  settle(request: ProfileCreditSettleRequest): Promise<void>;
};

const CreditReservationSchema = z.object({
  admissionId: z.string(),
  heldCostUsd: z.number().finite().nonnegative(),
  items: z.array(
    z.object({
      model: z.string(),
      variant: z.string().nullable(),
      estimatedCostUsd: z.number().finite().nonnegative(),
      status: z.enum(['held', 'settled']),
      chargedCostUsd: z.number().finite().nonnegative().nullable(),
    })
  ),
});
const InsufficientCreditsSchema = z.object({
  error: z.literal('insufficient_credits'),
  availableCostUsd: z.number().finite().nonnegative(),
  requiredCostUsd: z.number().finite().nonnegative(),
});

const CreditSettlementSchema = z.object({
  admissionId: z.string(),
  model: z.string(),
  variant: z.string().nullable(),
  runId: z.string().nullable(),
  chargedCostUsd: z.number().finite().nonnegative(),
  releasedCostUsd: z.number().finite().nonnegative(),
});

export class ProfileCreditBridgeError extends Error {
  constructor(readonly status: number) {
    super(
      `Benchmark credit bridge failed (${status}). Admission will be reconciled automatically.`
    );
    this.name = 'ProfileCreditBridgeError';
  }
}

export class ProfileReservationMismatchError extends Error {
  constructor() {
    super('Benchmark credit bridge returned a mismatched reservation; echoed holds were released.');
    this.name = 'ProfileReservationMismatchError';
  }
}

export function createProfileCreditBridge(input: {
  webUrl: string;
  internalApiSecret: string;
}): ProfileCreditBridge {
  async function post(action: 'reserve' | 'settle', body: unknown): Promise<Response> {
    return fetch(new URL(`/api/internal/auto-routing-benchmark/billing/${action}`, input.webUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.internalApiSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }
  async function settle(request: ProfileCreditSettleRequest): Promise<void> {
    const response = await post('settle', request);
    if (!response.ok) throw new ProfileCreditBridgeError(response.status);
    const settled = CreditSettlementSchema.parse(await response.json());
    if (
      settled.admissionId !== request.admissionId ||
      settled.model !== request.model ||
      settled.variant !== request.variant ||
      settled.runId !== request.runId ||
      settled.chargedCostUsd !== Math.round(request.actualCostUsd * 1_000_000) / 1_000_000
    ) {
      throw new Error('Benchmark credit bridge returned a mismatched settlement.');
    }
  }
  return {
    async reserve(request) {
      const response = await post('reserve', request);
      if (response.status === 402) {
        const insufficient = InsufficientCreditsSchema.parse(await response.json());
        return {
          kind: 'insufficient',
          availableCostUsd: insufficient.availableCostUsd,
          requiredCostUsd: insufficient.requiredCostUsd,
        };
      }
      if (!response.ok) throw new ProfileCreditBridgeError(response.status);
      const held = CreditReservationSchema.parse(await response.json());
      const requested = new Map(request.items.map(item => [benchmarkPairKey(item), item]));
      if (
        held.admissionId !== request.admissionId ||
        held.items.length !== requested.size ||
        new Set(held.items.map(benchmarkPairKey)).size !== requested.size ||
        held.items.some(item => {
          const expected = requested.get(benchmarkPairKey(item));
          return (
            !expected ||
            estimateMicrodollars(expected.estimatedCostUsd) !== Math.round(item.estimatedCostUsd * 1_000_000)
          );
        })
      ) {
        const released = new Set<string>();
        for (const item of held.items) {
          const key = benchmarkPairKey(item);
          if (item.status !== 'held' || released.has(key)) continue;
          await settle({
            admissionId: held.admissionId,
            ownerType: request.ownerType,
            ownerId: request.ownerId,
            model: item.model,
            variant: item.variant,
            runId: null,
            actualCostUsd: 0,
          });
          released.add(key);
        }
        throw new ProfileReservationMismatchError();
      }
      return { kind: 'held' };
    },
    settle,
  };
}

export type ProfileBenchmarkClaim = typeof profileBenchmarkClaims.$inferSelect;
export type ProfileBenchmarkAdmission = typeof profileBenchmarkAdmissions.$inferSelect;
export type ProfileAdmissionItem = ProfileCreditItem & { quotaCharged: boolean };
export type AllocateProfileAdmissionInput = ProfileCreditOwner & {
  engineIdentity: string;
  repetitions: number;
  items: readonly ProfileAdmissionItem[];
  admissionLimit: number;
  windowStart: string;
  now: string;
};

export async function allocateProfileAdmission(
  db: D1Database,
  input: AllocateProfileAdmissionInput
): Promise<{ admissionId: string; claims: ProfileBenchmarkClaim[]; quotaExceeded: boolean }> {
  const orm = drizzle(db);
  const admissionId = crypto.randomUUID();
  const statements: BatchItem<'sqlite'>[] = [
    orm.insert(profileBenchmarkAdmissions).values({
      admission_id: admissionId,
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      engine_identity: input.engineIdentity,
      repetitions: input.repetitions,
      state: 'allocating',
      created_at: input.now,
      updated_at: input.now,
    }),
  ];
  for (const item of input.items) {
    statements.push(
      orm
        .insert(profileBenchmarkClaims)
        .select(sql`
        SELECT ${admissionId}, ${item.model}, ${variantToStorage(item.variant)},
          ${input.engineIdentity}, ${input.repetitions}, ${item.estimatedCostUsd},
          NULL, ${item.quotaCharged ? 1 : 0}, 'allocating', NULL, NULL,
          ${input.now}, ${input.now}, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM ${benchmarkProfiles}
          WHERE ${benchmarkProfiles.model} = ${item.model}
            AND ${benchmarkProfiles.variant} = ${variantToStorage(item.variant)}
            AND ${benchmarkProfiles.engine_identity} = ${input.engineIdentity}
            AND ${benchmarkProfiles.repetitions} = ${input.repetitions}
            AND ${benchmarkProfiles.status} IN ('pending', 'running', 'ready')
        )
      `)
        .onConflictDoNothing()
    );
  }
  statements.push(
    orm
      .update(profileBenchmarkAdmissions)
      .set({
        state: sql`CASE WHEN (
        (SELECT COUNT(*) FROM ${profileRequestEvents}
          WHERE ${profileRequestEvents.owner_type} = ${input.ownerType}
            AND ${profileRequestEvents.owner_id} = ${input.ownerId}
            AND ${profileRequestEvents.admitted_at} >= ${input.windowStart})
        + (SELECT COUNT(*) FROM (
          SELECT c.admission_id, c.model FROM ${profileBenchmarkClaims} c
          JOIN ${profileBenchmarkAdmissions} a ON a.admission_id = c.admission_id
          WHERE a.owner_type = ${input.ownerType} AND a.owner_id = ${input.ownerId}
            AND a.state = 'allocating' AND c.state = 'allocating' AND c.quota_charged = 1
          GROUP BY c.admission_id, c.model
        ))
      ) > ${input.admissionLimit} THEN 'quota_exceeded' ELSE 'allocating' END`,
      })
      .where(eq(profileBenchmarkAdmissions.admission_id, admissionId)),
    orm
      .update(profileBenchmarkClaims)
      .set({
        state: 'released',
        charged_cost_usd: 0,
        settled_at: input.now,
      })
      .where(
        and(
          eq(profileBenchmarkClaims.admission_id, admissionId),
          sql`EXISTS (SELECT 1 FROM ${profileBenchmarkAdmissions}
        WHERE ${profileBenchmarkAdmissions.admission_id} = ${admissionId}
          AND ${profileBenchmarkAdmissions.state} = 'quota_exceeded')`
        )
      )
  );
  await orm.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  const [admission] = await orm
    .select()
    .from(profileBenchmarkAdmissions)
    .where(eq(profileBenchmarkAdmissions.admission_id, admissionId));
  const claims = await orm
    .select()
    .from(profileBenchmarkClaims)
    .where(eq(profileBenchmarkClaims.admission_id, admissionId));
  return { admissionId, claims, quotaExceeded: admission?.state === 'quota_exceeded' };
}

function claimIdentity(claim: ProfileBenchmarkClaim) {
  return and(
    eq(profileBenchmarkClaims.admission_id, claim.admission_id),
    eq(profileBenchmarkClaims.model, claim.model),
    eq(profileBenchmarkClaims.variant, claim.variant)
  );
}

async function releaseUnusedHolds(
  db: D1Database,
  billing: ProfileCreditBridge,
  admission: ProfileBenchmarkAdmission,
  now: string
): Promise<void> {
  const orm = drizzle(db);
  const claims = await orm
    .select()
    .from(profileBenchmarkClaims)
    .where(
      and(
        eq(profileBenchmarkClaims.admission_id, admission.admission_id),
        eq(profileBenchmarkClaims.state, 'release_pending')
      )
    );
  for (const claim of claims) {
    await billing.settle({
      admissionId: admission.admission_id,
      ownerType: admission.owner_type,
      ownerId: admission.owner_id,
      model: claim.model,
      variant: variantFromStorage(claim.variant),
      runId: null,
      actualCostUsd: 0,
    });
    await orm
      .update(profileBenchmarkClaims)
      .set({
        state: 'released',
        charged_cost_usd: 0,
        settled_at: now,
        updated_at: now,
      })
      .where(and(claimIdentity(claim), eq(profileBenchmarkClaims.state, 'release_pending')));
  }
}

export async function recoverProfileAdmission(
  db: D1Database,
  billing: ProfileCreditBridge,
  admissionId: string,
  now: Date = new Date()
): Promise<ProfileCreditReserveResult> {
  const orm = drizzle(db);
  const nowIso = now.toISOString();
  const [admission] = await orm
    .select()
    .from(profileBenchmarkAdmissions)
    .where(eq(profileBenchmarkAdmissions.admission_id, admissionId));
  if (!admission) throw new Error(`Benchmark admission ${admissionId} does not exist.`);
  if (admission.state !== 'allocating') {
    await releaseUnusedHolds(db, billing, admission, nowIso);
    return { kind: 'held' };
  }
  const claims = await orm
    .select()
    .from(profileBenchmarkClaims)
    .where(eq(profileBenchmarkClaims.admission_id, admissionId));
  if (claims.length === 0) {
    await orm
      .update(profileBenchmarkAdmissions)
      .set({ state: 'admitted', updated_at: nowIso })
      .where(
        and(
          eq(profileBenchmarkAdmissions.admission_id, admissionId),
          eq(profileBenchmarkAdmissions.state, 'allocating')
        )
      );
    return { kind: 'held' };
  }
  let reservation: ProfileCreditReserveResult;
  try {
    reservation = await billing.reserve({
      admissionId,
      ownerType: admission.owner_type,
      ownerId: admission.owner_id,
      items: claims.map(claim => ({
        model: claim.model,
        variant: variantFromStorage(claim.variant),
        estimatedCostUsd: claim.estimated_cost_usd,
      })),
    });
  } catch (error) {
    if (error instanceof ProfileReservationMismatchError) {
      await orm.batch([
        orm.update(profileBenchmarkClaims)
          .set({ state: 'released', charged_cost_usd: 0, settled_at: nowIso, updated_at: nowIso })
          .where(and(eq(profileBenchmarkClaims.admission_id, admissionId), eq(profileBenchmarkClaims.state, 'allocating'))),
        orm.update(profileBenchmarkAdmissions)
          .set({ state: 'admitted', updated_at: nowIso })
          .where(and(eq(profileBenchmarkAdmissions.admission_id, admissionId), eq(profileBenchmarkAdmissions.state, 'allocating'))),
      ]);
    }
    throw error;
  }
  if (reservation.kind === 'insufficient') {
    await orm.batch([
      orm
        .update(profileBenchmarkClaims)
        .set({ state: 'released', charged_cost_usd: 0, settled_at: nowIso, updated_at: nowIso })
        .where(
          and(
            eq(profileBenchmarkClaims.admission_id, admissionId),
            eq(profileBenchmarkClaims.state, 'allocating')
          )
        ),
      orm
        .update(profileBenchmarkAdmissions)
        .set({ state: 'insufficient', updated_at: nowIso })
        .where(
          and(
            eq(profileBenchmarkAdmissions.admission_id, admissionId),
            eq(profileBenchmarkAdmissions.state, 'allocating')
          )
        ),
    ]);
    return reservation;
  }

  const statements: BatchItem<'sqlite'>[] = [];
  for (const claim of claims) {
    // The claim transition follows its insert in the same D1 transaction: changes()
    // distinguishes our admitted row from a platform row that won during reserve.
    statements.push(
      orm.insert(benchmarkProfiles).select(sql`
        SELECT ${claim.model}, ${claim.variant}, ${claim.engine_identity}, ${claim.repetitions},
          'pending', NULL, NULL, ${claim.created_at}, ${nowIso}, NULL, 0, 1
        WHERE EXISTS (
          SELECT 1 FROM ${profileBenchmarkClaims}
          WHERE ${profileBenchmarkClaims.admission_id} = ${admissionId}
            AND ${profileBenchmarkClaims.model} = ${claim.model}
            AND ${profileBenchmarkClaims.variant} = ${claim.variant}
            AND ${profileBenchmarkClaims.state} = 'allocating'
        )
        ON CONFLICT (model, variant, engine_identity, repetitions) DO UPDATE SET
          status = 'pending', run_id = NULL, failure_reason = NULL,
          requested_at = excluded.requested_at, updated_at = excluded.updated_at,
          completed_at = NULL, user_requested = 1
        WHERE ${benchmarkProfiles.status} = 'failed'
      `),
      orm
        .update(profileBenchmarkClaims)
        .set({
          state: sql`CASE WHEN changes() > 0 THEN 'admitted' ELSE 'release_pending' END`,
          updated_at: nowIso,
        })
        .where(and(claimIdentity(claim), eq(profileBenchmarkClaims.state, 'allocating')))
    );
  }
  statements.push(
    orm
      .update(benchmarkProfiles)
      .set({ user_requested: true, updated_at: nowIso })
      .where(
        and(
          eq(benchmarkProfiles.engine_identity, admission.engine_identity),
          eq(benchmarkProfiles.repetitions, admission.repetitions),
          sql`EXISTS (SELECT 1 FROM ${profileBenchmarkClaims} c
        WHERE c.admission_id = ${admissionId}
          AND c.model = ${benchmarkProfiles.model}
          AND c.variant = ${benchmarkProfiles.variant})`
        )
      ),
    orm.insert(profileRequestEvents).select(sql`
      SELECT NULL, ${admission.owner_type}, ${admission.owner_id}, c.model, MIN(c.variant),
        ${admission.engine_identity}, ${admission.repetitions}, ${nowIso}
      FROM ${profileBenchmarkClaims} c
      WHERE c.admission_id = ${admissionId} AND c.state = 'admitted' AND c.quota_charged = 1
        AND EXISTS (SELECT 1 FROM ${profileBenchmarkAdmissions} a
          WHERE a.admission_id = ${admissionId} AND a.state = 'allocating')
      GROUP BY c.model
    `),
    orm
      .update(profileBenchmarkAdmissions)
      .set({ state: 'admitted', updated_at: nowIso })
      .where(
        and(
          eq(profileBenchmarkAdmissions.admission_id, admissionId),
          eq(profileBenchmarkAdmissions.state, 'allocating')
        )
      )
  );
  await orm.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  await releaseUnusedHolds(db, billing, admission, nowIso);
  return reservation;
}

export async function recoverPendingProfileAdmissions(
  db: D1Database,
  billing: ProfileCreditBridge,
  now: Date = new Date()
): Promise<void> {
  const orm = drizzle(db);
  const admissions = await orm
    .select()
    .from(profileBenchmarkAdmissions)
    .where(and(
      or(isNull(profileBenchmarkAdmissions.recovery_next_at), lte(profileBenchmarkAdmissions.recovery_next_at, now.toISOString())),
      sql`(${profileBenchmarkAdmissions.state} = 'allocating' OR EXISTS (
        SELECT 1 FROM ${profileBenchmarkClaims}
        WHERE ${profileBenchmarkClaims.admission_id} = ${profileBenchmarkAdmissions.admission_id}
          AND ${profileBenchmarkClaims.state} = 'release_pending'
      ))`
    ))
    .orderBy(asc(profileBenchmarkAdmissions.recovery_next_at), asc(profileBenchmarkAdmissions.created_at))
    .limit(100);
  let firstError: unknown;
  for (const admission of admissions) {
    const nextAttempt = admission.recovery_attempts + 1;
    const delayMs = Math.min(24 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** Math.min(nextAttempt - 1, 7));
    const claimed = await orm.update(profileBenchmarkAdmissions).set({
      recovery_attempts: sql`${profileBenchmarkAdmissions.recovery_attempts} + 1`,
      recovery_next_at: new Date(now.getTime() + delayMs).toISOString(),
    }).where(and(
      eq(profileBenchmarkAdmissions.admission_id, admission.admission_id),
      or(isNull(profileBenchmarkAdmissions.recovery_next_at), lte(profileBenchmarkAdmissions.recovery_next_at, now.toISOString()))
    ));
    if ((claimed.meta.changes ?? 0) === 0) continue;
    try {
      await recoverProfileAdmission(db, billing, admission.admission_id, now);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export async function loadActiveProfileClaims(
  db: D1Database,
  pairs: readonly BenchmarkPair[],
  current: { engineIdentity: string; repetitions: number }
): Promise<ProfileBenchmarkClaim[]> {
  if (pairs.length === 0) return [];
  const wanted = new Set(pairs.map(benchmarkPairKey));
  const claims = await drizzle(db)
    .select()
    .from(profileBenchmarkClaims)
    .where(
      and(
        inArray(profileBenchmarkClaims.model, [...new Set(pairs.map(pair => pair.model))]),
        eq(profileBenchmarkClaims.engine_identity, current.engineIdentity),
        eq(profileBenchmarkClaims.repetitions, current.repetitions),
        inArray(profileBenchmarkClaims.state, ['allocating', 'admitted']),
        sql`${profileBenchmarkClaims.terminal_status} IS NULL`
      )
    );
  return claims.filter(claim =>
    wanted.has(benchmarkPairKey({ model: claim.model, variant: variantFromStorage(claim.variant) }))
  );
}
