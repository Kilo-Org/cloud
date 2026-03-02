/**
 * Security Analysis - Database Operations
 *
 * Database operations for security finding analysis workflow.
 * Handles analysis status updates, concurrency control, and cleanup.
 */

import { db } from '@/lib/drizzle';
import { security_findings } from '@kilocode/db/schema';
import { eq, and, sql, count, isNotNull, desc, or } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { SecurityFinding } from '@kilocode/db/schema';
import type {
  SecurityReviewOwner,
  SecurityFindingAnalysis,
  SecurityFindingAnalysisStatus,
} from '../core/types';

/**
 * Owner type for database queries
 */
type Owner = { type: 'org'; id: string } | { type: 'user'; id: string };

/**
 * Convert SecurityReviewOwner to Owner format used in queries
 */
function toOwner(owner: SecurityReviewOwner): Owner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'org', id: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', id: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

/**
 * Update analysis status for a finding
 */
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

    // Auto-set timestamps and clear previous state based on status
    if (status === 'pending') {
      // Clear previous error, analysis, and session IDs when starting a new analysis
      // BUT preserve analysis if explicitly provided (e.g., triage data before sandbox runs)
      updateData.analysis_error = null;
      if (updates.analysis === undefined) {
        updateData.analysis = null;
      }
      updateData.analysis_completed_at = null;
      updateData.session_id = null;
      updateData.cli_session_id = null;
    }
    if (status === 'running') {
      // IMPORTANT: don't reset started_at on repeated "running" updates (status events arrive frequently).
      // Only set if it is currently null.
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

/**
 * Count currently running analyses for an owner
 */
export async function countRunningAnalyses(owner: SecurityReviewOwner): Promise<number> {
  try {
    const ownerConverted = toOwner(owner);
    const conditions = [];

    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    // Count pending and running analyses
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

/**
 * Check if owner can start a new analysis (within concurrency limit)
 */
export async function canStartAnalysis(
  owner: SecurityReviewOwner,
  maxConcurrent = 3
): Promise<{ allowed: boolean; currentCount: number; limit: number }> {
  const currentCount = await countRunningAnalyses(owner);
  return {
    allowed: currentCount < maxConcurrent,
    currentCount,
    limit: maxConcurrent,
  };
}

/**
 * Get findings pending analysis for an owner
 */
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

    // Only open findings without analysis
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

/**
 * Clean up stale "running" analyses (e.g., from crashed sessions)
 * Call this periodically via cron job
 */
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
          sql`${security_findings.analysis_started_at} < now() - make_interval(mins => ${maxAgeMinutes})`
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

/**
 * List findings that have analysis status (for jobs view)
 * Returns findings ordered by analysis_started_at desc (most recent first)
 */
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

    // Only findings with analysis status set
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

/**
 * Count findings with analysis status (for pagination)
 */
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

    // Only findings with analysis status set
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
