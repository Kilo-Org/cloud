import type { WorkerDb } from '@kilocode/db/client';
import { platform_integrations, security_audit_log, security_findings } from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import { parseDependabotDismissalTarget } from '@kilocode/worker-utils/dependabot-dismissal-target';
import { eq, sql } from 'drizzle-orm';
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

export async function maybeAutoDismissCompletedAnalysis(params: {
  db: WorkerDb;
  env: CloudflareEnv;
  findingId: string;
  finding: SecurityFindingRecord;
  analysis: SecurityFindingAnalysis;
}): Promise<void> {
  if (params.finding.status === 'ignored') return;

  const owner = findingOwner(params.finding);
  if (!owner) return;
  const config = await getSecurityAgentConfigForOwner(params.db, owner);
  if (!config.auto_dismiss_enabled) return;

  const sandbox = params.analysis.sandboxAnalysis;
  if (sandbox?.isExploitable === false) {
    await params.db
      .update(security_findings)
      .set({
        status: 'ignored',
        ignored_reason: 'not_used',
        ignored_by: 'auto-sandbox',
        updated_at: sql`now()`.mapWith(String),
      })
      .where(eq(security_findings.id, params.findingId));

    await writeBackDependabotDismissal({
      db: params.db,
      env: params.env,
      finding: params.finding,
      comment: sandbox.exploitabilityReasoning,
    });

    await params.db.insert(security_audit_log).values({
      owned_by_organization_id: params.finding.owned_by_organization_id,
      owned_by_user_id: params.finding.owned_by_user_id,
      actor_id: null,
      actor_email: null,
      actor_name: null,
      action: SecurityAuditLogAction.FindingAutoDismissed,
      resource_type: 'security_finding',
      resource_id: params.findingId,
      after_state: { status: 'ignored' },
      metadata: {
        source: 'system',
        trigger: 'auto_dismiss_policy',
        dismissSource: 'sandbox',
        correlationId: params.analysis.correlationId,
      },
    });
    return;
  }

  const triage = params.analysis.triage;
  if (
    triage?.suggestedAction !== 'dismiss' ||
    !meetsAutoDismissConfidenceThreshold(
      config.auto_dismiss_confidence_threshold,
      triage.confidence
    )
  ) {
    return;
  }

  await params.db
    .update(security_findings)
    .set({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-triage',
      updated_at: sql`now()`.mapWith(String),
    })
    .where(eq(security_findings.id, params.findingId));

  await writeBackDependabotDismissal({
    db: params.db,
    env: params.env,
    finding: params.finding,
    comment: triage.needsSandboxReasoning,
  });

  await params.db.insert(security_audit_log).values({
    owned_by_organization_id: params.finding.owned_by_organization_id,
    owned_by_user_id: params.finding.owned_by_user_id,
    actor_id: null,
    actor_email: null,
    actor_name: null,
    action: SecurityAuditLogAction.FindingAutoDismissed,
    resource_type: 'security_finding',
    resource_id: params.findingId,
    after_state: { status: 'ignored' },
    metadata: {
      source: 'system',
      trigger: 'auto_dismiss_policy',
      dismissSource: 'triage',
      confidence: triage.confidence,
      correlationId: params.analysis.correlationId,
    },
  });
}
