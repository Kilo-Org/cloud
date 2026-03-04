import { db } from '@/lib/drizzle';
import {
  security_findings,
  security_analysis_queue,
  security_analysis_owner_state,
} from '@kilocode/db/schema';
import { eq, and, sql, count, isNotNull, desc, or, isNull } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { SecurityFinding } from '@kilocode/db/schema';
import type {
  AutoAnalysisMinSeverity,
  SecurityFindingStatus,
  SecuritySeverity,
  SecurityReviewOwner,
  SecurityFindingAnalysis,
  SecurityFindingAnalysisStatus,
} from '../core/types';
import { SECURITY_ANALYSIS_OWNER_CAP } from '../core/constants';

type Owner = { type: 'org'; id: string } | { type: 'user'; id: string };

function toOwner(owner: SecurityReviewOwner): Owner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'org', id: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', id: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

export type AutoAnalysisQueueStatus = 'queued' | 'pending' | 'running' | 'failed' | 'completed';

export type AutoAnalysisFailureCode =
  | 'NETWORK_TIMEOUT'
  | 'UPSTREAM_5XX'
  | 'TEMP_TOKEN_FAILURE'
  | 'SKIPPED_NO_LONGER_ELIGIBLE'
  | 'REOPEN_LOOP_GUARD'
  | 'SKIPPED_ALREADY_IN_PROGRESS'
  | 'ACTOR_RESOLUTION_FAILED'
  | 'GITHUB_TOKEN_UNAVAILABLE'
  | 'INVALID_CONFIG'
  | 'MISSING_OWNERSHIP'
  | 'PERMISSION_DENIED_PERMANENT'
  | 'UNSUPPORTED_SEVERITY'
  | 'STATE_GUARD_REJECTED'
  | 'REQUEUE_TEMPORARY_PRECONDITION'
  | 'INSUFFICIENT_CREDITS'
  | 'START_CALL_AMBIGUOUS'
  | 'RUN_LOST';

export type AutoAnalysisQueueSyncResult = {
  enqueueCount: number;
  eligibleCount: number;
  boundarySkipCount: number;
  unknownSeverityCount: number;
};

export const AUTO_ANALYSIS_REOPEN_REQUEUE_CAP = 2;
export const AUTO_ANALYSIS_OWNER_CAP = 2;
export const AUTO_ANALYSIS_MAX_ATTEMPTS = 5;

const severityRankBySeverity = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
} satisfies Record<SecuritySeverity, number>;

function minSeverityToMaxRank(minSeverity: AutoAnalysisMinSeverity): number {
  switch (minSeverity) {
    case 'critical':
      return severityRankBySeverity.critical;
    case 'high':
      return severityRankBySeverity.high;
    case 'medium':
      return severityRankBySeverity.medium;
    case 'all':
      return severityRankBySeverity.low;
  }
}

export function getSeverityRank(severity: string | null | undefined): number | null {
  if (severity === 'critical') return severityRankBySeverity.critical;
  if (severity === 'high') return severityRankBySeverity.high;
  if (severity === 'medium') return severityRankBySeverity.medium;
  if (severity === 'low') return severityRankBySeverity.low;
  return null;
}

export function isFindingEligibleForAutoAnalysis(params: {
  findingCreatedAt: string;
  findingStatus: string;
  severity: string | null;
  ownerAutoAnalysisEnabledAt: string | null;
  isAgentEnabled: boolean;
  autoAnalysisEnabled: boolean;
  autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
}): { eligible: boolean; severityRank: number | null } {
  const severityRank = getSeverityRank(params.severity);

  if (!params.isAgentEnabled || !params.autoAnalysisEnabled) {
    return { eligible: false, severityRank };
  }
  if (params.findingStatus !== 'open') {
    return { eligible: false, severityRank };
  }
  if (!params.ownerAutoAnalysisEnabledAt) {
    return { eligible: false, severityRank };
  }
  if (Date.parse(params.findingCreatedAt) < Date.parse(params.ownerAutoAnalysisEnabledAt)) {
    return { eligible: false, severityRank };
  }
  if (severityRank == null) {
    return { eligible: false, severityRank: null };
  }

  const maxRank = minSeverityToMaxRank(params.autoAnalysisMinSeverity);
  return { eligible: severityRank <= maxRank, severityRank };
}

export async function updateAnalysisStatus(
  findingId: string,
  status: SecurityFindingAnalysisStatus,
  updates: {
    sessionId?: string;
    cliSessionId?: string;
    error?: string;
    analysis?: SecurityFindingAnalysis;
  } = {}
): Promise<void> {
  try {
    const updateData: Record<string, unknown> = {
      analysis_status: status,
      updated_at: sql`now()`,
    };

    if (updates.sessionId !== undefined) {
      updateData.session_id = updates.sessionId;
    }
    if (updates.cliSessionId !== undefined) {
      updateData.cli_session_id = updates.cliSessionId;
    }
    if (updates.error !== undefined) {
      updateData.analysis_error = updates.error;
    }
    if (updates.analysis !== undefined) {
      updateData.analysis = updates.analysis;
    }

    if (status === 'pending') {
      updateData.analysis_error = null;
      // Preserve analysis if explicitly provided (e.g. triage data before sandbox runs)
      if (updates.analysis === undefined) {
        updateData.analysis = null;
      }
      updateData.analysis_completed_at = null;
      updateData.session_id = null;
      updateData.cli_session_id = null;
    }
    if (status === 'running') {
      // Only set started_at once (coalesce keeps the original value)
      updateData.analysis_started_at = sql`coalesce(${security_findings.analysis_started_at}, now())`;
    }
    if (status === 'completed' || status === 'failed') {
      updateData.analysis_completed_at = sql`now()`;
    }

    await db.update(security_findings).set(updateData).where(eq(security_findings.id, findingId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateAnalysisStatus' },
      extra: { findingId, status, updates },
    });
    throw error;
  }
}

export async function countRunningAnalyses(owner: SecurityReviewOwner): Promise<number> {
  try {
    const ownerConverted = toOwner(owner);
    const conditions = [];

    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    conditions.push(
      or(
        eq(security_findings.analysis_status, 'pending'),
        eq(security_findings.analysis_status, 'running')
      )
    );

    const result = await db
      .select({ count: count() })
      .from(security_findings)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'countRunningAnalyses' },
      extra: { owner },
    });
    throw error;
  }
}

export async function canStartAnalysis(
  owner: SecurityReviewOwner,
  maxConcurrent = SECURITY_ANALYSIS_OWNER_CAP
): Promise<{ allowed: boolean; currentCount: number; limit: number }> {
  const currentCount = await countRunningAnalyses(owner);
  return {
    allowed: currentCount < maxConcurrent,
    currentCount,
    limit: maxConcurrent,
  };
}

export async function getFindingsPendingAnalysis(
  owner: SecurityReviewOwner,
  limit = 10
): Promise<string[]> {
  try {
    const ownerConverted = toOwner(owner);
    const conditions = [];

    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    conditions.push(eq(security_findings.status, 'open'));
    conditions.push(sql`${security_findings.analysis_status} IS NULL`);

    const findings = await db
      .select({ id: security_findings.id })
      .from(security_findings)
      .where(and(...conditions))
      .limit(limit);

    return findings.map(f => f.id);
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getFindingsPendingAnalysis' },
      extra: { owner, limit },
    });
    throw error;
  }
}

/** Clean up stale "running" analyses from crashed sessions. */
export async function cleanupStaleAnalyses(maxAgeMinutes = 30): Promise<number> {
  try {
    const result = await db
      .update(security_findings)
      .set({
        analysis_status: 'failed',
        analysis_error: 'Analysis timed out or was interrupted',
        analysis_completed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(security_findings.analysis_status, 'running'),
          sql`${security_findings.analysis_started_at} < now() - make_interval(mins => ${maxAgeMinutes})`,
          sql`NOT EXISTS (
            SELECT 1
            FROM ${security_analysis_queue}
            WHERE ${security_analysis_queue.finding_id} = ${security_findings.id}
              AND ${security_analysis_queue.queue_status} IN ('pending', 'running')
          )`
        )
      )
      .returning({ id: security_findings.id });

    return result.length;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'cleanupStaleAnalyses' },
      extra: { maxAgeMinutes },
    });
    throw error;
  }
}

export async function listSecurityFindingsWithAnalysis(params: {
  owner: SecurityReviewOwner;
  limit?: number;
  offset?: number;
}): Promise<SecurityFinding[]> {
  try {
    const { owner, limit = 10, offset = 0 } = params;
    const ownerConverted = toOwner(owner);
    const conditions = [];

    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    conditions.push(isNotNull(security_findings.analysis_status));

    const findings = await db
      .select()
      .from(security_findings)
      .where(and(...conditions))
      .orderBy(desc(security_findings.analysis_started_at))
      .limit(limit)
      .offset(offset);

    return findings;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'listSecurityFindingsWithAnalysis' },
      extra: { params },
    });
    throw error;
  }
}

export async function countSecurityFindingsWithAnalysis(
  owner: SecurityReviewOwner
): Promise<number> {
  try {
    const ownerConverted = toOwner(owner);
    const conditions = [];

    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    conditions.push(isNotNull(security_findings.analysis_status));

    const result = await db
      .select({ count: count() })
      .from(security_findings)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'countSecurityFindingsWithAnalysis' },
      extra: { owner },
    });
    throw error;
  }
}

export async function getOwnerAutoAnalysisEnabledAt(
  owner: SecurityReviewOwner
): Promise<string | null> {
  const ownerConverted = toOwner(owner);
  const ownerCondition =
    ownerConverted.type === 'org'
      ? eq(security_analysis_owner_state.owned_by_organization_id, ownerConverted.id)
      : eq(security_analysis_owner_state.owned_by_user_id, ownerConverted.id);

  const [state] = await db
    .select({ autoAnalysisEnabledAt: security_analysis_owner_state.auto_analysis_enabled_at })
    .from(security_analysis_owner_state)
    .where(ownerCondition)
    .limit(1);

  return state?.autoAnalysisEnabledAt ?? null;
}

export async function setOwnerAutoAnalysisEnabledAtNow(owner: SecurityReviewOwner): Promise<void> {
  const ownerConverted = toOwner(owner);
  const ownerCondition =
    ownerConverted.type === 'org'
      ? eq(security_analysis_owner_state.owned_by_organization_id, ownerConverted.id)
      : eq(security_analysis_owner_state.owned_by_user_id, ownerConverted.id);

  await db
    .insert(security_analysis_owner_state)
    .values({
      owned_by_organization_id: ownerConverted.type === 'org' ? ownerConverted.id : null,
      owned_by_user_id: ownerConverted.type === 'user' ? ownerConverted.id : null,
      auto_analysis_enabled_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .onConflictDoNothing();

  await db
    .update(security_analysis_owner_state)
    .set({ auto_analysis_enabled_at: sql`now()`, updated_at: sql`now()` })
    .where(and(ownerCondition, isNull(security_analysis_owner_state.auto_analysis_enabled_at)));
}

export async function syncAutoAnalysisQueueForFinding(params: {
  owner: SecurityReviewOwner;
  findingId: string;
  findingCreatedAt: string;
  previousStatus: SecurityFindingStatus | null;
  currentStatus: SecurityFindingStatus;
  severity: string | null;
  isAgentEnabled: boolean;
  autoAnalysisEnabled: boolean;
  autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
  ownerAutoAnalysisEnabledAt: string | null;
}): Promise<AutoAnalysisQueueSyncResult> {
  const ownerConverted = toOwner(params.owner);
  const { eligible, severityRank } = isFindingEligibleForAutoAnalysis({
    findingCreatedAt: params.findingCreatedAt,
    findingStatus: params.currentStatus,
    severity: params.severity,
    ownerAutoAnalysisEnabledAt: params.ownerAutoAnalysisEnabledAt,
    isAgentEnabled: params.isAgentEnabled,
    autoAnalysisEnabled: params.autoAnalysisEnabled,
    autoAnalysisMinSeverity: params.autoAnalysisMinSeverity,
  });
  const isBoundarySkip =
    params.ownerAutoAnalysisEnabledAt != null &&
    Date.parse(params.findingCreatedAt) < Date.parse(params.ownerAutoAnalysisEnabledAt);
  const unknownSeverityCount = severityRank == null ? 1 : 0;
  let enqueueCount = 0;

  await db.transaction(async tx => {
    if (severityRank != null) {
      await tx
        .update(security_analysis_queue)
        .set({
          severity_rank: severityRank,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(security_analysis_queue.finding_id, params.findingId),
            eq(security_analysis_queue.queue_status, 'queued')
          )
        );
    }

    if (!eligible) {
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'completed',
          failure_code: 'SKIPPED_NO_LONGER_ELIGIBLE',
          claim_token: null,
          claimed_at: null,
          claimed_by_job_id: null,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(security_analysis_queue.finding_id, params.findingId),
            eq(security_analysis_queue.queue_status, 'queued')
          )
        );
    }

    const isReopened =
      (params.previousStatus === 'fixed' || params.previousStatus === 'ignored') &&
      params.currentStatus === 'open';

    if (isReopened && eligible) {
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'queued',
          queued_at: sql`now()`,
          attempt_count: 0,
          next_retry_at: null,
          failure_code: null,
          last_error_redacted: null,
          claimed_at: null,
          claimed_by_job_id: null,
          claim_token: null,
          reopen_requeue_count: sql`${security_analysis_queue.reopen_requeue_count} + 1`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(security_analysis_queue.finding_id, params.findingId),
            or(
              eq(security_analysis_queue.queue_status, 'completed'),
              eq(security_analysis_queue.queue_status, 'failed')
            ),
            sql`${security_analysis_queue.reopen_requeue_count} < ${AUTO_ANALYSIS_REOPEN_REQUEUE_CAP}`
          )
        );

      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'failed',
          failure_code: 'REOPEN_LOOP_GUARD',
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(security_analysis_queue.finding_id, params.findingId),
            or(
              eq(security_analysis_queue.queue_status, 'completed'),
              eq(security_analysis_queue.queue_status, 'failed')
            ),
            sql`${security_analysis_queue.reopen_requeue_count} >= ${AUTO_ANALYSIS_REOPEN_REQUEUE_CAP}`
          )
        );
    }

    if (eligible) {
      const inserted = await tx
        .insert(security_analysis_queue)
        .values({
          finding_id: params.findingId,
          owned_by_organization_id: ownerConverted.type === 'org' ? ownerConverted.id : null,
          owned_by_user_id: ownerConverted.type === 'user' ? ownerConverted.id : null,
          queue_status: 'queued',
          severity_rank: severityRank ?? severityRankBySeverity.low,
          queued_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .onConflictDoNothing()
        .returning({ id: security_analysis_queue.id });
      enqueueCount = inserted.length;
    }
  });

  return {
    enqueueCount,
    eligibleCount: eligible ? 1 : 0,
    boundarySkipCount: isBoundarySkip ? 1 : 0,
    unknownSeverityCount,
  };
}

export async function tryAcquireAnalysisStartLease(findingId: string): Promise<boolean> {
  const [lease] = await db
    .update(security_findings)
    .set({
      analysis_status: 'pending',
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_findings.id, findingId),
        eq(security_findings.status, 'open'),
        or(
          isNull(security_findings.analysis_status),
          eq(security_findings.analysis_status, 'completed'),
          eq(security_findings.analysis_status, 'failed')
        )
      )
    )
    .returning({ id: security_findings.id });

  return Boolean(lease);
}

export async function transitionAutoAnalysisQueueFromCallback(params: {
  findingId: string;
  toStatus: 'completed' | 'failed';
  failureCode?: AutoAnalysisFailureCode;
  errorMessage?: string;
}): Promise<void> {
  const values: {
    queue_status: AutoAnalysisQueueStatus;
    failure_code: string | null;
    last_error_redacted: string | null;
    updated_at: ReturnType<typeof sql>;
  } = {
    queue_status: params.toStatus,
    failure_code: params.failureCode ?? null,
    last_error_redacted: params.errorMessage ?? null,
    updated_at: sql`now()`,
  };

  await db
    .update(security_analysis_queue)
    .set(values)
    .where(
      and(
        eq(security_analysis_queue.finding_id, params.findingId),
        or(
          eq(security_analysis_queue.queue_status, 'running'),
          eq(security_analysis_queue.queue_status, 'pending')
        )
      )
    );
}
