import type { WorkerDb } from '@kilocode/db/client';
import {
  platform_integrations,
  security_findings,
  type SecurityFinding,
} from '@kilocode/db/schema';
import {
  SecurityAuditLogAction,
  SecurityFindingAuditSourceContext,
} from '@kilocode/db/schema-types';
import { parseDependabotDismissalTarget } from '@kilocode/worker-utils/dependabot-dismissal-target';
import {
  SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
  deriveSecurityFindingAuditEventKey,
  insertSecurityFindingAuditEvent,
  type SecurityFindingAuditOwner,
} from '@kilocode/worker-utils/security-finding-audit';
import { and, eq } from 'drizzle-orm';
import { getSecurityAgentConfigForOwner, type SecurityFindingRecord } from './db/queries.js';
import { logger } from './logger.js';
import type { QueueOwner, SecurityFindingAnalysis } from './types.js';

function findingOwner(finding: SecurityFindingRecord): QueueOwner | null {
  if (finding.owned_by_organization_id) {
    return { type: 'org', id: finding.owned_by_organization_id };
  }
  if (finding.owned_by_user_id) {
    return { type: 'user', id: finding.owned_by_user_id };
  }
  return null;
}

function toAuditOwner(owner: QueueOwner): SecurityFindingAuditOwner {
  return owner.type === 'org'
    ? { type: 'organization', organizationId: owner.id }
    : { type: 'user', userId: owner.id };
}

function ownerAuditKeyPart(owner: QueueOwner): string {
  return owner.type === 'org' ? `organization:${owner.id}` : `user:${owner.id}`;
}

function ownerFindingCondition(owner: QueueOwner) {
  return owner.type === 'org'
    ? eq(security_findings.owned_by_organization_id, owner.id)
    : eq(security_findings.owned_by_user_id, owner.id);
}

function meetsAutoDismissConfidenceThreshold(
  threshold: 'high' | 'medium' | 'low',
  confidence: 'high' | 'medium' | 'low'
): boolean {
  return (
    threshold === 'low' ||
    (threshold === 'medium' && confidence !== 'low') ||
    (threshold === 'high' && confidence === 'high')
  );
}

async function writeBackDependabotDismissal(params: {
  db: WorkerDb;
  env: CloudflareEnv;
  finding: SecurityFindingRecord;
  comment: string;
}): Promise<void> {
  if (params.finding.source !== 'dependabot' || !params.finding.platform_integration_id) {
    return;
  }
  const target = parseDependabotDismissalTarget({
    sourceId: params.finding.source_id,
    repoFullName: params.finding.repo_full_name,
  });
  if (!target) return;

  const rows = await params.db
    .select({ installationId: platform_integrations.platform_installation_id })
    .from(platform_integrations)
    .where(eq(platform_integrations.id, params.finding.platform_integration_id))
    .limit(1);
  const installationId = rows[0]?.installationId;
  if (!installationId) return;

  try {
    const token = await params.env.GIT_TOKEN_SERVICE.getToken(installationId);
    const response = await fetch(
      `https://api.github.com/repos/${target.repoOwner}/${target.repoName}/dependabot/alerts/${target.alertNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'cloudflare-security-auto-analysis',
        },
        body: JSON.stringify({
          state: 'dismissed',
          dismissed_reason: 'not_used',
          dismissed_comment: `[Kilo Code auto-dismiss] ${params.comment}`,
        }),
      }
    );
    if (!response.ok) {
      logger.warn('Dependabot auto-dismiss writeback failed', {
        finding_id: params.finding.id,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn('Dependabot auto-dismiss writeback threw', {
      finding_id: params.finding.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function dismissFindingWithAuditEvent(params: {
  db: WorkerDb;
  findingId: string;
  owner: QueueOwner;
  analysis: SecurityFindingAnalysis;
  dismissSource: 'sandbox' | 'triage';
  confidence?: 'high' | 'medium' | 'low';
}): Promise<SecurityFinding | null> {
  const occurredAt = new Date().toISOString();
  const analysisIdentity =
    params.analysis.correlationId ??
    params.analysis.sandboxAnalysis?.analysisAt ??
    params.analysis.triage?.triageAt ??
    params.analysis.analyzedAt;
  if (!analysisIdentity) {
    throw new Error('Auto-dismiss audit event requires an analysis identity');
  }

  return params.db.transaction(async tx => {
    const [finding] = await tx
      .select()
      .from(security_findings)
      .where(and(eq(security_findings.id, params.findingId), ownerFindingCondition(params.owner)))
      .for('update')
      .limit(1);
    if (!finding || finding.status !== 'open') return null;

    const [updatedFinding] = await tx
      .update(security_findings)
      .set({
        status: 'ignored',
        ignored_reason: 'not_used',
        ignored_by: `auto-${params.dismissSource}`,
        updated_at: occurredAt,
      })
      .where(
        and(
          eq(security_findings.id, params.findingId),
          ownerFindingCondition(params.owner),
          eq(security_findings.status, 'open')
        )
      )
      .returning();
    if (!updatedFinding) return null;

    await insertSecurityFindingAuditEvent(tx, {
      owner: toAuditOwner(params.owner),
      finding: updatedFinding,
      actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
      action: SecurityAuditLogAction.FindingAutoDismissed,
      occurredAt,
      eventKey: deriveSecurityFindingAuditEventKey([
        ownerAuditKeyPart(params.owner),
        updatedFinding.id,
        SecurityAuditLogAction.FindingAutoDismissed,
        params.dismissSource,
        analysisIdentity,
      ]),
      sourceContext: SecurityFindingAuditSourceContext.AnalysisWorker,
      beforeState: { status: finding.status },
      afterState: { status: 'ignored', reason_code: 'not_used' },
      metadata: {
        reason_code: 'not_used',
        trigger: 'auto_dismiss_policy',
        dismiss_source: params.dismissSource,
        ...(params.confidence ? { confidence: params.confidence } : {}),
        ...(params.analysis.correlationId ? { correlation_id: params.analysis.correlationId } : {}),
      },
    });

    return updatedFinding;
  });
}

export async function maybeAutoDismissCompletedAnalysis(params: {
  db: WorkerDb;
  env: CloudflareEnv;
  findingId: string;
  finding: SecurityFindingRecord;
  analysis: SecurityFindingAnalysis;
}): Promise<void> {
  const owner = findingOwner(params.finding);
  if (!owner) return;
  const config = await getSecurityAgentConfigForOwner(params.db, owner);
  if (!config.auto_dismiss_enabled) return;

  const sandbox = params.analysis.sandboxAnalysis;
  if (sandbox) {
    if (sandbox.isExploitable !== false || sandbox.suggestedAction !== 'dismiss') return;

    const dismissedFinding = await dismissFindingWithAuditEvent({
      db: params.db,
      findingId: params.findingId,
      owner,
      analysis: params.analysis,
      dismissSource: 'sandbox',
    });
    if (!dismissedFinding) return;

    await writeBackDependabotDismissal({
      db: params.db,
      env: params.env,
      finding: dismissedFinding,
      comment: sandbox.exploitabilityReasoning,
    });
    return;
  }

  const triage = params.analysis.triage;
  if (
    triage?.needsSandboxAnalysis !== false ||
    triage.suggestedAction !== 'dismiss' ||
    !meetsAutoDismissConfidenceThreshold(
      config.auto_dismiss_confidence_threshold,
      triage.confidence
    )
  ) {
    return;
  }

  const dismissedFinding = await dismissFindingWithAuditEvent({
    db: params.db,
    findingId: params.findingId,
    owner,
    analysis: params.analysis,
    dismissSource: 'triage',
    confidence: triage.confidence,
  });
  if (!dismissedFinding) return;

  await writeBackDependabotDismissal({
    db: params.db,
    env: params.env,
    finding: dismissedFinding,
    comment: triage.needsSandboxReasoning,
  });
}
