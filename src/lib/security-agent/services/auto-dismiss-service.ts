/**
 * Auto-Dismiss Service
 *
 * Handles automatic dismissal of security findings based on analysis results.
 * Auto-dismiss is OFF by default and must be explicitly enabled per-organization.
 *
 * Unified auto-dismiss logic:
 * - After Tier 1 triage: if triage.suggestedAction === 'dismiss' (with confidence threshold)
 * - After Tier 2 sandbox: if sandboxAnalysis.isExploitable === false (no confidence threshold)
 */

import 'server-only';
import { db } from '@/lib/drizzle';
import { security_findings } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { trackSecurityAgentAutoDismiss } from '../posthog-tracking';
import { updateSecurityFindingStatus } from '../db/security-findings';
import { getSecurityAgentConfig } from '../db/security-config';
import type { Owner } from '@/lib/code-reviews/core';
import type { SecurityFindingAnalysis, SecurityReviewOwner } from '../core/types';
import { sentryLogger } from '@/lib/utils.server';

const log = sentryLogger('security-agent:auto-dismiss', 'info');
const logError = sentryLogger('security-agent:auto-dismiss', 'error');

/**
 * Convert SecurityReviewOwner + userId to Owner format for config lookups.
 * The userId represents the user performing the action (needed for audit/permissions).
 */
function toOwner(securityOwner: SecurityReviewOwner, userId: string): Owner {
  if ('organizationId' in securityOwner && securityOwner.organizationId) {
    return { type: 'org', id: securityOwner.organizationId, userId };
  }
  if ('userId' in securityOwner && securityOwner.userId) {
    return { type: 'user', id: securityOwner.userId, userId: securityOwner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

/**
 * Dismiss a security finding with the given reason
 */
export async function dismissFinding(
  findingId: string,
  params: {
    reason: string;
    comment: string;
    dismissedBy?: string;
  }
): Promise<void> {
  await updateSecurityFindingStatus(findingId, 'ignored', {
    ignoredReason: params.reason,
    ignoredBy: params.dismissedBy || `auto-dismiss: ${params.comment}`,
  });
}

/**
 * Auto-dismiss source - indicates which analysis triggered the dismissal
 */
type AutoDismissSource = 'triage' | 'sandbox';

/**
 * Unified auto-dismiss function that handles both triage and sandbox analysis.
 * Only runs if auto-dismiss is enabled in config.
 *
 * Priority:
 * 1. If sandboxAnalysis exists and isExploitable === false -> dismiss (no confidence threshold)
 * 2. If triage.suggestedAction === 'dismiss' -> dismiss (with confidence threshold)
 *
 * @param options.findingId - The ID of the finding to potentially dismiss
 * @param options.analysis - The full analysis result (triage + optional sandbox)
 * @param options.owner - The security review owner (org or user)
 * @param options.userId - The user performing the action (for audit/permissions)
 * @param options.correlationId - Correlation ID for tracing across the analysis pipeline
 * @returns Object with dismissed status and source
 */
export async function maybeAutoDismissAnalysis(options: {
  findingId: string;
  analysis: SecurityFindingAnalysis;
  owner: SecurityReviewOwner;
  userId: string;
  correlationId?: string;
}): Promise<{ dismissed: boolean; source?: AutoDismissSource }> {
  const { findingId, analysis, owner, userId, correlationId = '' } = options;
  const ownerConverted = toOwner(owner, userId);
  const config = await getSecurityAgentConfig(ownerConverted);

  // Check if auto-dismiss is enabled (default: false)
  if (!config.auto_dismiss_enabled) {
    return { dismissed: false };
  }

  // Priority 1: Check sandbox analysis (no confidence threshold - sandbox is definitive)
  if (analysis.sandboxAnalysis?.isExploitable === false) {
    await dismissFinding(findingId, {
      reason: 'not_used',
      comment: analysis.sandboxAnalysis.exploitabilityReasoning,
      dismissedBy: 'auto-sandbox',
    });

    log('Auto-dismissed finding (sandbox)', {
      correlationId,
      findingId,
      reasoning: analysis.sandboxAnalysis.exploitabilityReasoning.slice(0, 100),
    });

    trackSecurityAgentAutoDismiss({
      distinctId: userId,
      userId,
      organizationId: 'organizationId' in owner ? owner.organizationId : undefined,
      findingId,
      source: 'sandbox',
    });

    return { dismissed: true, source: 'sandbox' };
  }

  // Priority 2: Check triage (with confidence threshold)
  const triage = analysis.triage;
  if (triage?.suggestedAction === 'dismiss') {
    const threshold = config.auto_dismiss_confidence_threshold ?? 'high';

    // Check confidence threshold
    const meetsThreshold =
      threshold === 'low' ||
      (threshold === 'medium' && triage.confidence !== 'low') ||
      (threshold === 'high' && triage.confidence === 'high');

    if (meetsThreshold) {
      await dismissFinding(findingId, {
        reason: 'not_used',
        comment: triage.needsSandboxReasoning,
        dismissedBy: 'auto-triage',
      });

      log('Auto-dismissed finding (triage)', {
        correlationId,
        findingId,
        confidence: triage.confidence,
        reasoning: triage.needsSandboxReasoning.slice(0, 100),
      });

      trackSecurityAgentAutoDismiss({
        distinctId: userId,
        userId,
        organizationId: 'organizationId' in owner ? owner.organizationId : undefined,
        findingId,
        source: 'triage',
        confidence: triage.confidence,
      });

      return { dismissed: true, source: 'triage' };
    }
  }

  return { dismissed: false };
}

/**
 * Result of bulk auto-dismiss operation
 */
export type AutoDismissResult = {
  dismissed: number;
  skipped: number;
  errors: number;
};

/**
 * Bulk auto-dismiss all findings that meet criteria.
 * Respects config settings.
 *
 * This is useful for processing findings that were triaged before auto-dismiss was enabled.
 *
 * @param owner - The security review owner (org or user)
 * @param userId - The user performing the action (for audit/permissions)
 */
export async function autoDismissEligibleFindings(
  owner: SecurityReviewOwner,
  userId: string
): Promise<AutoDismissResult> {
  const ownerConverted = toOwner(owner, userId);
  const config = await getSecurityAgentConfig(ownerConverted);

  if (!config.auto_dismiss_enabled) {
    return { dismissed: 0, skipped: 0, errors: 0 };
  }

  const threshold = config.auto_dismiss_confidence_threshold ?? 'high';

  // Build owner condition
  const ownerCondition =
    ownerConverted.type === 'org'
      ? eq(security_findings.owned_by_organization_id, ownerConverted.id)
      : eq(security_findings.owned_by_user_id, ownerConverted.id);

  // Find completed analyses where triage suggests dismiss
  const findings = await db
    .select({
      id: security_findings.id,
      analysis: security_findings.analysis,
    })
    .from(security_findings)
    .where(
      and(
        ownerCondition,
        eq(security_findings.status, 'open'),
        eq(security_findings.analysis_status, 'completed'),
        sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'dismiss'`
      )
    );

  let dismissed = 0;
  let skipped = 0;
  let errors = 0;

  for (const finding of findings) {
    try {
      const analysis = finding.analysis;
      const triage = analysis?.triage;

      if (!triage) {
        skipped++;
        continue;
      }

      // Check confidence threshold
      if (threshold === 'high' && triage.confidence !== 'high') {
        skipped++;
        continue;
      }
      if (threshold === 'medium' && triage.confidence === 'low') {
        skipped++;
        continue;
      }

      await dismissFinding(finding.id, {
        reason: 'not_used',
        comment: triage.needsSandboxReasoning,
        dismissedBy: 'auto-triage-bulk',
      });
      dismissed++;
    } catch (error) {
      logError('Error dismissing finding', { findingId: finding.id, error });
      captureException(error, {
        tags: { operation: 'autoDismissEligibleFindings' },
        extra: { findingId: finding.id },
      });
      errors++;
    }
  }

  log('Bulk auto-dismiss complete', { dismissed, skipped, errors });

  trackSecurityAgentAutoDismiss({
    distinctId: userId,
    userId,
    organizationId: 'organizationId' in owner ? owner.organizationId : undefined,
    source: 'bulk',
    dismissed,
    skipped,
    errors,
  });

  return { dismissed, skipped, errors };
}

/**
 * Get count of findings eligible for auto-dismiss.
 * Useful for showing in UI before running bulk dismiss.
 *
 * @param owner - The security review owner (org or user)
 * @param userId - The user performing the action (for audit/permissions)
 */
export async function countEligibleForAutoDismiss(
  owner: SecurityReviewOwner,
  userId: string
): Promise<{
  eligible: number;
  byConfidence: { high: number; medium: number; low: number };
}> {
  const ownerConverted = toOwner(owner, userId);

  // Build owner condition
  const ownerCondition =
    ownerConverted.type === 'org'
      ? eq(security_findings.owned_by_organization_id, ownerConverted.id)
      : eq(security_findings.owned_by_user_id, ownerConverted.id);

  // Find completed analyses where triage suggests dismiss
  const findings = await db
    .select({
      analysis: security_findings.analysis,
    })
    .from(security_findings)
    .where(
      and(
        ownerCondition,
        eq(security_findings.status, 'open'),
        eq(security_findings.analysis_status, 'completed'),
        sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'dismiss'`
      )
    );

  const byConfidence = { high: 0, medium: 0, low: 0 };

  for (const finding of findings) {
    const analysis = finding.analysis;
    const confidence = analysis?.triage?.confidence;
    if (confidence && confidence in byConfidence) {
      byConfidence[confidence]++;
    }
  }

  return {
    eligible: findings.length,
    byConfidence,
  };
}
