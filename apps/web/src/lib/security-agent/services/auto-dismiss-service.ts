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
import pLimit from 'p-limit';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { security_findings, type SecurityFinding } from '@kilocode/db/schema';
import { and, count, eq, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { trackSecurityAgentAutoDismiss } from '../posthog-tracking';
import { updateSecurityFindingStatus } from '../db/security-findings';
import { getSecurityAgentConfig } from '../db/security-config';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { dismissDependabotAlert } from '../github/dependabot-api';
import type { Owner } from '@/lib/code-reviews/core';
import type { SecurityFindingAnalysis, SecurityReviewOwner } from '../core/types';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
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

// Each bulk item holds a dismissal transaction and one GitHub request.
const AUTO_DISMISS_CONCURRENCY = 5;

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
 * Rows a bulk auto-dismiss run or an eligibility count may consider.
 * The per-row triage policy runs in the application tier so both paths stay in step.
 */
function autoDismissCandidateCondition(owner: Owner) {
  return and(
    owner.type === 'org'
      ? eq(security_findings.owned_by_organization_id, owner.id)
      : eq(security_findings.owned_by_user_id, owner.id),
    eq(security_findings.status, 'open'),
    eq(security_findings.analysis_status, 'completed'),
    sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'dismiss'`
  );
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
): Promise<SecurityFinding | null> {
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
      return null;
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

    return updatedFinding;
  });
}

/**
 * The finding fields a Dependabot dismissal writeback needs.
 */
type DependabotWritebackFinding = Pick<
  SecurityFinding,
  'id' | 'source' | 'source_id' | 'repo_full_name'
>;

/**
 * Write back a dismissal to Dependabot on GitHub for an already-loaded finding.
 * The caller resolves the owner's GitHub installation id once and passes it in, so a bulk run
 * performs one integration lookup instead of one per finding.
 * May throw on API errors — use safeWritebackDependabotDismissal when failures should be non-fatal.
 */
export async function writebackDependabotDismissal(
  finding: DependabotWritebackFinding,
  installationId: string | null,
  dismissedComment: string
): Promise<void> {
  if (finding.source !== 'dependabot') {
    return;
  }

  const target = parseDependabotDismissalTarget({
    sourceId: finding.source_id,
    repoFullName: finding.repo_full_name,
  });
  if (!target) {
    return;
  }

  if (!installationId) {
    log('Skipping Dependabot writeback — no GitHub installation ID', { findingId: finding.id });
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

  log('Wrote back Dependabot dismissal', {
    findingId: finding.id,
    alertNumber: target.alertNumber,
  });
}

/**
 * Safely attempt Dependabot writeback, reporting failures with the external API status and message.
 */
async function safeWritebackDependabotDismissal(
  finding: DependabotWritebackFinding,
  installationId: string | null,
  dismissedComment: string
): Promise<void> {
  try {
    await writebackDependabotDismissal(finding, installationId, dismissedComment);
  } catch (error) {
    // Octokit request errors expose status and message on the rejection value.
    const apiError = error as { status?: number; message?: string };
    logError('Dependabot writeback failed', {
      findingId: finding.id,
      status: apiError.status,
      message: apiError.message,
    });
  }
}

/**
 * The owner's GitHub installation id, or null when the owner has no GitHub integration.
 */
async function resolveGitHubInstallationId(owner: Owner): Promise<string | null> {
  const integration = await getIntegrationForOwner(owner, 'github');
  return integration?.platform_installation_id ?? null;
}

/**
 * Write back a dismissed finding to Dependabot, resolving the owner's GitHub installation id first.
 * Non-Dependabot findings need no lookup.
 */
async function writebackDependabotForFinding(
  finding: SecurityFinding,
  owner: Owner,
  dismissedComment: string
): Promise<void> {
  if (finding.source !== 'dependabot') {
    return;
  }

  await safeWritebackDependabotDismissal(
    finding,
    await resolveGitHubInstallationId(owner),
    dismissedComment
  );
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

  if (!config.auto_dismiss_enabled) {
    return { dismissed: false };
  }

  const sandbox = analysis.sandboxAnalysis;
  if (sandbox) {
    if (sandbox.isExploitable !== false || sandbox.suggestedAction !== 'dismiss') {
      return { dismissed: false };
    }

    const dismissedFinding = await dismissFindingWithAuditEvent(findingId, {
      owner,
      reason: 'not_used',
      comment: sandbox.exploitabilityReasoning,
      dismissedBy: 'auto-sandbox',
      dismissSource: 'sandbox',
      correlationId,
      actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
    });
    if (!dismissedFinding) return { dismissed: false };

    await writebackDependabotForFinding(
      dismissedFinding,
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

    const meetsThreshold =
      threshold === 'low' ||
      (threshold === 'medium' && triage.confidence !== 'low') ||
      (threshold === 'high' && triage.confidence === 'high');

    if (meetsThreshold) {
      const dismissedFinding = await dismissFindingWithAuditEvent(findingId, {
        owner,
        reason: 'not_used',
        comment: triage.needsSandboxReasoning,
        dismissedBy: 'auto-triage',
        dismissSource: 'triage',
        confidence: triage.confidence,
        correlationId,
        actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
      });
      if (!dismissedFinding) return { dismissed: false };

      await writebackDependabotForFinding(
        dismissedFinding,
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
  const installationId = await resolveGitHubInstallationId(ownerConverted);

  const findings = await db
    .select({
      id: security_findings.id,
      analysis: security_findings.analysis,
    })
    .from(security_findings)
    .where(autoDismissCandidateCondition(ownerConverted));

  let dismissed = 0;
  let skipped = 0;
  let errors = 0;

  const limit = pLimit(AUTO_DISMISS_CONCURRENCY);

  await Promise.all(
    findings.map(finding =>
      limit(async () => {
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
            return;
          }

          if (threshold === 'high' && triage.confidence !== 'high') {
            skipped++;
            return;
          }
          if (threshold === 'medium' && triage.confidence === 'low') {
            skipped++;
            return;
          }

          const dismissedFinding = await dismissFindingWithAuditEvent(finding.id, {
            owner,
            reason: 'not_used',
            comment: triage.needsSandboxReasoning,
            dismissedBy: 'auto-triage-bulk',
            dismissSource: 'bulk',
            confidence: triage.confidence,
            correlationId: operationId,
            actor,
          });
          if (!dismissedFinding) {
            skipped++;
            return;
          }
          await safeWritebackDependabotDismissal(
            dismissedFinding,
            installationId,
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
      })
    )
  );

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
 * The count is independent of the configured confidence threshold: it reports every finding the
 * triage policy accepts, broken down by confidence, so the caller can apply its own threshold
 * (autoDismissEligibleFindings skips findings below `auto_dismiss_confidence_threshold`) or show
 * the breakdown before deciding.
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

  // Mirrors the triage policy autoDismissEligibleFindings applies per finding, so the count
  // and the bulk run agree: triage present, no sandbox result, sandbox analysis not needed,
  // and a known confidence.
  const confidence = sql<string>`${security_findings.analysis}->'triage'->>'confidence'`;

  const rows = await db
    .select({
      confidence,
      count: count(),
    })
    .from(security_findings)
    .where(
      and(
        autoDismissCandidateCondition(ownerConverted),
        sql`jsonb_typeof(${security_findings.analysis}->'triage') = 'object'`,
        sql`jsonb_typeof(${security_findings.analysis}->'sandboxAnalysis') IS NULL`,
        sql`jsonb_typeof(${security_findings.analysis}->'triage'->'needsSandboxAnalysis') = 'boolean'`,
        sql`(${security_findings.analysis}->'triage'->>'needsSandboxAnalysis') = 'false'`,
        sql`${confidence} IN ('high', 'medium', 'low')`
      )
    )
    .groupBy(confidence);

  const byConfidence = { high: 0, medium: 0, low: 0 };
  let eligible = 0;

  for (const row of rows) {
    if (!isTriageConfidence(row.confidence)) continue;

    eligible += row.count;
    byConfidence[row.confidence] += row.count;
  }

  return {
    eligible,
    byConfidence,
  };
}
