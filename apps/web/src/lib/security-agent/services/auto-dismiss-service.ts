/**
 * Auto-Dismiss Service
 *
 * Handles automatic dismissal of security findings based on analysis results.
 * Auto-dismiss is OFF by default and must be explicitly enabled per-organization.
 *
 * Unified auto-dismiss logic:
 * - After Tier 1 triage: dismiss only when no sandbox is needed and confidence meets policy
 * - After Tier 2 sandbox: dismiss only when analysis says not exploitable and recommends dismissal
 */

import 'server-only';
import { db } from '@/lib/drizzle';
import { security_findings } from '@kilocode/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { trackSecurityAgentAutoDismiss } from '../posthog-tracking';
import { updateSecurityFindingStatus, getSecurityFindingById } from '../db/security-findings';
import { getSecurityAgentConfig } from '../db/security-config';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { dismissDependabotAlert } from '../github/dependabot-api';
import type { Owner } from '@/lib/code-reviews/core';
import type { SecurityFindingAnalysis, SecurityReviewOwner } from '../core/types';
import { sentryLogger } from '@/lib/utils.server';
import {
  SecurityAuditLogAction,
  SecurityFindingAuditSourceContext,
} from '@kilocode/db/schema-types';
import {
  SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
  deriveSecurityFindingAuditEventKey,
  insertSecurityFindingAuditEvent,
  type SecurityFindingAuditActor,
  type SecurityFindingAuditHumanActor,
  type SecurityFindingAuditOwner,
} from '@kilocode/worker-utils/security-finding-audit';
import { parseDependabotDismissalTarget } from '@kilocode/worker-utils/dependabot-dismissal-target';

const log = sentryLogger('security-agent:auto-dismiss', 'info');
const logError = sentryLogger('security-agent:auto-dismiss', 'error');
const TRIAGE_CONFIDENCES = ['high', 'medium', 'low'] as const;

type TriageConfidence = (typeof TRIAGE_CONFIDENCES)[number];

function isTriageConfidence(value: unknown): value is TriageConfidence {
  return TRIAGE_CONFIDENCES.includes(value as TriageConfidence);
}

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

function toAuditOwner(owner: SecurityReviewOwner): SecurityFindingAuditOwner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'organization', organizationId: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', userId: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

function ownerAuditKeyPart(owner: SecurityReviewOwner): string {
  if ('organizationId' in owner && owner.organizationId)
    return `organization:${owner.organizationId}`;
  if ('userId' in owner && owner.userId) return `user:${owner.userId}`;
  throw new Error('Invalid owner: must have either organizationId or userId');
}

function ownerFindingCondition(owner: SecurityReviewOwner) {
  if ('organizationId' in owner && owner.organizationId) {
    return eq(security_findings.owned_by_organization_id, owner.organizationId);
  }
  if ('userId' in owner && owner.userId) {
    return eq(security_findings.owned_by_user_id, owner.userId);
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

async function dismissFindingWithAuditEvent(
  findingId: string,
  params: {
    owner: SecurityReviewOwner;
    reason: string;
    comment: string;
    dismissedBy: string;
    dismissSource: AutoDismissSource | 'bulk';
    confidence?: string | null;
    correlationId?: string;
    actor: SecurityFindingAuditActor;
  }
): Promise<boolean> {
  const occurredAt = new Date().toISOString();
  return db.transaction(async tx => {
    const [finding] = await tx
      .select()
      .from(security_findings)
      .where(and(eq(security_findings.id, findingId), ownerFindingCondition(params.owner)))
      .for('update')
      .limit(1);

    if (!finding) {
      throw new Error('Security finding not found for owner');
    }

    if (finding.status !== 'open') {
      return false;
    }

    const ignoredBy = params.dismissedBy || `auto-dismiss: ${params.comment}`;
    const [updatedFinding] = await tx
      .update(security_findings)
      .set({
        status: 'ignored',
        ignored_reason: params.reason,
        ignored_by: ignoredBy,
        updated_at: occurredAt,
      })
      .where(
        and(
          eq(security_findings.id, findingId),
          ownerFindingCondition(params.owner),
          eq(security_findings.status, 'open')
        )
      )
      .returning();

    if (!updatedFinding) {
      throw new Error('Security finding status update failed');
    }

    await insertSecurityFindingAuditEvent(tx, {
      owner: toAuditOwner(params.owner),
      finding: updatedFinding,
      actor: params.actor,
      action: SecurityAuditLogAction.FindingAutoDismissed,
      occurredAt,
      eventKey: deriveSecurityFindingAuditEventKey([
        ownerAuditKeyPart(params.owner),
        findingId,
        SecurityAuditLogAction.FindingAutoDismissed,
        params.dismissSource,
        params.correlationId || 'none',
      ]),
      sourceContext: SecurityFindingAuditSourceContext.Web,
      beforeState: { status: finding.status },
      afterState: { status: 'ignored', reason_code: params.reason },
      metadata: {
        trigger: 'auto_dismiss_policy',
        dismiss_source: params.dismissSource,
        ...(params.confidence ? { confidence: params.confidence } : {}),
        ...(params.correlationId ? { correlation_id: params.correlationId } : {}),
      },
    });

    return true;
  });
}

/**
 * Write back a dismissal to Dependabot on GitHub.
 * Fetches the finding and integration data, then calls the Dependabot API.
 * May throw on API or DB errors — use safeWritebackDependabotDismissal when failures should be non-fatal.
 */
export async function writebackDependabotDismissal(
  findingId: string,
  owner: Owner,
  dismissedComment: string
): Promise<void> {
  const finding = await getSecurityFindingById(findingId);
  if (!finding || finding.source !== 'dependabot') {
    return;
  }

  const target = parseDependabotDismissalTarget({
    sourceId: finding.source_id,
    repoFullName: finding.repo_full_name,
  });
  if (!target) {
    return;
  }

  const integration = await getIntegrationForOwner(owner, 'github');
  const installationId = integration?.platform_installation_id;
  if (!installationId) {
    log('Skipping Dependabot writeback — no GitHub installation ID', { findingId });
    return;
  }

  await dismissDependabotAlert(
    installationId,
    target.repoOwner,
    target.repoName,
    target.alertNumber,
    'not_used',
    `[Kilo Code auto-dismiss] ${dismissedComment}`
  );

  log('Wrote back Dependabot dismissal', { findingId, alertNumber: target.alertNumber });
}

/**
 * Safely attempt Dependabot writeback, catching and logging any errors.
 */
async function safeWritebackDependabotDismissal(
  findingId: string,
  owner: Owner,
  dismissedComment: string
): Promise<void> {
  try {
    await writebackDependabotDismissal(findingId, owner, dismissedComment);
  } catch (error) {
    logError('Dependabot writeback failed', { findingId, error });
    captureException(error, {
      tags: { operation: 'writebackDependabotDismissal' },
      extra: { findingId },
    });
  }
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
 * 1. Treat any sandbox analysis as authoritative and dismiss only a coherent not-exploitable result
 * 2. Without sandbox analysis, dismiss a triage result only when no sandbox is needed
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

  const sandbox = analysis.sandboxAnalysis;
  if (sandbox) {
    if (sandbox.isExploitable !== false || sandbox.suggestedAction !== 'dismiss') {
      return { dismissed: false };
    }

    const dismissed = await dismissFindingWithAuditEvent(findingId, {
      owner,
      reason: 'not_used',
      comment: sandbox.exploitabilityReasoning,
      dismissedBy: 'auto-sandbox',
      dismissSource: 'sandbox',
      correlationId,
      actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
    });
    if (!dismissed) return { dismissed: false };

    await safeWritebackDependabotDismissal(
      findingId,
      ownerConverted,
      sandbox.exploitabilityReasoning
    );

    log('Auto-dismissed finding (sandbox)', {
      correlationId,
      findingId,
      reasoning: sandbox.exploitabilityReasoning.slice(0, 100),
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

  const triage = analysis.triage;
  if (triage?.needsSandboxAnalysis === false && triage.suggestedAction === 'dismiss') {
    const threshold = config.auto_dismiss_confidence_threshold ?? 'high';

    // Check confidence threshold
    const meetsThreshold =
      threshold === 'low' ||
      (threshold === 'medium' && triage.confidence !== 'low') ||
      (threshold === 'high' && triage.confidence === 'high');

    if (meetsThreshold) {
      const dismissed = await dismissFindingWithAuditEvent(findingId, {
        owner,
        reason: 'not_used',
        comment: triage.needsSandboxReasoning,
        dismissedBy: 'auto-triage',
        dismissSource: 'triage',
        confidence: triage.confidence,
        correlationId,
        actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
      });
      if (!dismissed) return { dismissed: false };

      await safeWritebackDependabotDismissal(
        findingId,
        ownerConverted,
        triage.needsSandboxReasoning
      );

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
 * @param actor - The user performing the bulk action
 */
export async function autoDismissEligibleFindings(
  owner: SecurityReviewOwner,
  actor: SecurityFindingAuditHumanActor
): Promise<AutoDismissResult> {
  const userId = actor.id;
  const ownerConverted = toOwner(owner, userId);
  const operationId = crypto.randomUUID();
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

      if (
        !triage ||
        analysis?.sandboxAnalysis !== undefined ||
        triage.needsSandboxAnalysis !== false ||
        triage.suggestedAction !== 'dismiss'
      ) {
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

      const didDismiss = await dismissFindingWithAuditEvent(finding.id, {
        owner,
        reason: 'not_used',
        comment: triage.needsSandboxReasoning,
        dismissedBy: 'auto-triage-bulk',
        dismissSource: 'bulk',
        confidence: triage.confidence,
        correlationId: operationId,
        actor,
      });
      if (!didDismiss) {
        skipped++;
        continue;
      }
      await safeWritebackDependabotDismissal(
        finding.id,
        ownerConverted,
        triage.needsSandboxReasoning
      );
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
  let eligible = 0;

  for (const finding of findings) {
    const analysis = finding.analysis;
    const triage = analysis?.triage;
    if (
      !triage ||
      analysis?.sandboxAnalysis !== undefined ||
      triage.needsSandboxAnalysis !== false ||
      triage.suggestedAction !== 'dismiss'
    ) {
      continue;
    }

    if (!isTriageConfidence(triage.confidence)) continue;

    eligible++;
    byConfidence[triage.confidence]++;
  }

  return {
    eligible,
    byConfidence,
  };
}
