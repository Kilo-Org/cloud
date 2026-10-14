import { and, eq, exists, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { formatError } from '@kilocode/worker-utils';
import {
  benchmarkProfiles,
  benchmarkRuns,
  caseResults,
  profileBenchmarkAdmissions,
  profileBenchmarkClaims,
} from './db-schema';
import type { ProfileCreditBridge } from './profile-billing';
import { variantFromStorage } from './reasoning-effort';

function recordBenchmarkSettlementOutcomesStatement(
  orm: DrizzleD1Database,
  runId: string | undefined,
  nowIso: string
) {
  const failedRun = orm
    .select({ id: benchmarkRuns.id })
    .from(benchmarkRuns)
    .where(
      and(eq(benchmarkRuns.id, profileBenchmarkClaims.run_id), eq(benchmarkRuns.status, 'failed'))
    );
  const terminalProfile = orm
    .select({ status: benchmarkProfiles.status })
    .from(benchmarkProfiles)
    .where(
      and(
        eq(benchmarkProfiles.model, profileBenchmarkClaims.model),
        eq(benchmarkProfiles.variant, profileBenchmarkClaims.variant),
        eq(benchmarkProfiles.engine_identity, profileBenchmarkClaims.engine_identity),
        eq(benchmarkProfiles.repetitions, profileBenchmarkClaims.repetitions),
        eq(benchmarkProfiles.run_id, profileBenchmarkClaims.run_id),
        inArray(benchmarkProfiles.status, ['ready', 'failed'])
      )
    );
  const actualCost = orm
    .select({ cost: sql<number>`coalesce(sum(${caseResults.cost_usd}), 0)` })
    .from(caseResults)
    .where(
      and(
        eq(caseResults.run_id, profileBenchmarkClaims.run_id),
        eq(caseResults.model, profileBenchmarkClaims.model),
        eq(caseResults.variant, profileBenchmarkClaims.variant)
      )
    );
  const terminalStatus = sql<'ready' | 'failed'>`
    case when ${exists(failedRun)} then 'failed' else (${terminalProfile.getSQL()}) end
  `;
  return orm
    .update(profileBenchmarkClaims)
    .set({
      terminal_status: terminalStatus,
      charged_cost_usd: sql<number>`case when ${terminalStatus} = 'failed' then 0 else (${actualCost.getSQL()}) end`,
      updated_at: nowIso,
    })
    .where(
      and(
        eq(profileBenchmarkClaims.state, 'admitted'),
        runId === undefined ? undefined : eq(profileBenchmarkClaims.run_id, runId),
        or(
          and(isNull(profileBenchmarkClaims.terminal_status), exists(terminalProfile)),
          and(
            exists(failedRun),
            or(
              isNull(profileBenchmarkClaims.terminal_status),
              ne(profileBenchmarkClaims.terminal_status, 'failed')
            )
          )
        )
      )
    );
}

export async function recordBenchmarkSettlementOutcomes(
  db: D1Database,
  runId?: string
): Promise<void> {
  await recordBenchmarkSettlementOutcomesStatement(drizzle(db), runId, new Date().toISOString());
}

export async function recoverPendingBenchmarkSettlements(
  db: D1Database,
  billing: Pick<ProfileCreditBridge, 'settle'>,
  runId?: string
): Promise<void> {
  await recordBenchmarkSettlementOutcomes(db, runId);
  const orm = drizzle(db);
  const pending = await orm
    .select({
      admissionId: profileBenchmarkClaims.admission_id,
      ownerType: profileBenchmarkAdmissions.owner_type,
      ownerId: profileBenchmarkAdmissions.owner_id,
      model: profileBenchmarkClaims.model,
      variant: profileBenchmarkClaims.variant,
      runId: profileBenchmarkClaims.run_id,
      terminalStatus: profileBenchmarkClaims.terminal_status,
      actualCostUsd: profileBenchmarkClaims.charged_cost_usd,
    })
    .from(profileBenchmarkClaims)
    .innerJoin(
      profileBenchmarkAdmissions,
      eq(profileBenchmarkAdmissions.admission_id, profileBenchmarkClaims.admission_id)
    )
    .leftJoin(benchmarkRuns, eq(benchmarkRuns.id, profileBenchmarkClaims.run_id))
    .where(
      and(
        eq(profileBenchmarkClaims.state, 'admitted'),
        isNotNull(profileBenchmarkClaims.run_id),
        isNotNull(profileBenchmarkClaims.terminal_status),
        isNotNull(profileBenchmarkClaims.charged_cost_usd),
        or(
          inArray(benchmarkRuns.status, ['completed', 'failed']),
          and(isNull(benchmarkRuns.id), eq(profileBenchmarkClaims.terminal_status, 'failed'))
        ),
        runId === undefined ? undefined : eq(profileBenchmarkClaims.run_id, runId)
      )
    );

  for (const claim of pending) {
    try {
      if (
        claim.runId === null ||
        claim.actualCostUsd === null ||
        !Number.isFinite(claim.actualCostUsd) ||
        claim.actualCostUsd < 0 ||
        (claim.terminalStatus === 'failed' && claim.actualCostUsd !== 0)
      ) {
        throw new Error('benchmark settlement has an invalid persisted cost');
      }
      await billing.settle({
        admissionId: claim.admissionId,
        ownerType: claim.ownerType,
        ownerId: claim.ownerId,
        model: claim.model,
        variant: variantFromStorage(claim.variant),
        runId: claim.runId,
        actualCostUsd: claim.actualCostUsd,
      });
      const nowIso = new Date().toISOString();
      await orm
        .update(profileBenchmarkClaims)
        .set({ state: 'settled', settled_at: nowIso, updated_at: nowIso })
        .where(
          and(
            eq(profileBenchmarkClaims.admission_id, claim.admissionId),
            eq(profileBenchmarkClaims.model, claim.model),
            eq(profileBenchmarkClaims.variant, claim.variant),
            eq(profileBenchmarkClaims.run_id, claim.runId),
            eq(profileBenchmarkClaims.state, 'admitted')
          )
        );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_settlement_retry_pending',
          admissionId: claim.admissionId,
          runId: claim.runId,
          model: claim.model,
          variant: variantFromStorage(claim.variant),
          ...formatError(error),
        })
      );
    }
  }
}
