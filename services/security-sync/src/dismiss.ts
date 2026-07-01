import type { WorkerDb } from '@kilocode/db/client';
import { kilocode_users, security_findings } from '@kilocode/db/schema';
import {
  SecurityAuditLogAction,
  SecurityFindingAuditSourceContext,
} from '@kilocode/db/schema-types';
import { parseDependabotDismissalTarget } from '@kilocode/worker-utils/dependabot-dismissal-target';
import {
  buildSecurityFindingAuditHumanActor,
  deriveSecurityFindingAuditEventKey,
  insertSecurityFindingAuditEvent,
  type SecurityFindingAuditHumanActor,
  type SecurityFindingAuditOwner,
} from '@kilocode/worker-utils/security-finding-audit';
import { eq, sql } from 'drizzle-orm';
import type { SecurityDismissMessage } from './index.js';

type FindingDismissalResult = {
  dismissed: boolean;
  findingSource: string | null;
  commandStatus: 'succeeded' | 'failed' | 'no_op';
  resultCode: string;
};

type FindingOwner = {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
};

function findingMatchesOwner(
  finding: FindingOwner,
  owner: SecurityDismissMessage['owner']
): boolean {
  if (owner.organizationId) {
    return finding.owned_by_organization_id === owner.organizationId;
  }
  return Boolean(owner.userId && finding.owned_by_user_id === owner.userId);
}

function toAuditOwner(owner: SecurityDismissMessage['owner']): SecurityFindingAuditOwner {
  if (owner.organizationId) return { type: 'organization', organizationId: owner.organizationId };
  if (owner.userId) return { type: 'user', userId: owner.userId };
  throw new Error('Security Finding dismissal owner is missing');
}

function dismissalEventKey(params: {
  owner: SecurityDismissMessage['owner'];
  findingId: string;
  commandId: string;
}): string {
  const ownerPart = params.owner.organizationId
    ? `organization:${params.owner.organizationId}`
    : `user:${params.owner.userId}`;
  return deriveSecurityFindingAuditEventKey([
    ownerPart,
    params.findingId,
    SecurityAuditLogAction.FindingDismissed,
    params.commandId,
  ]);
}

async function getDismissalAuditActor(
  db: WorkerDb,
  actorUserId: string
): Promise<SecurityFindingAuditHumanActor> {
  const [actor] = await db
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      name: kilocode_users.google_user_name,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, actorUserId))
    .limit(1);
  if (!actor) throw new Error('Security Finding dismissal actor unavailable');
  return buildSecurityFindingAuditHumanActor(actor);
}

export async function processSecurityFindingDismissal(params: {
  db: WorkerDb;
  gitTokenService: GitTokenService;
  message: SecurityDismissMessage;
}): Promise<FindingDismissalResult> {
  const rows = await params.db
    .select({
      id: security_findings.id,
      source: security_findings.source,
      source_id: security_findings.source_id,
      repo_full_name: security_findings.repo_full_name,
      title: security_findings.title,
      severity: security_findings.severity,
      status: security_findings.status,
      package_name: security_findings.package_name,
      package_ecosystem: security_findings.package_ecosystem,
      manifest_path: security_findings.manifest_path,
      patched_version: security_findings.patched_version,
      ghsa_id: security_findings.ghsa_id,
      cve_id: security_findings.cve_id,
      cwe_ids: security_findings.cwe_ids,
      cvss_score: security_findings.cvss_score,
      dependabot_html_url: security_findings.dependabot_html_url,
      first_detected_at: security_findings.first_detected_at,
      fixed_at: security_findings.fixed_at,
      sla_due_at: security_findings.sla_due_at,
      session_id: security_findings.session_id,
      owned_by_organization_id: security_findings.owned_by_organization_id,
      owned_by_user_id: security_findings.owned_by_user_id,
    })
    .from(security_findings)
    .where(eq(security_findings.id, params.message.findingId))
    .limit(1);
  const finding = rows[0];

  if (!finding || !findingMatchesOwner(finding, params.message.owner)) {
    console.warn('Dismissal target finding unavailable for owner', {
      runId: params.message.runId,
      findingId: params.message.findingId,
    });
    return {
      dismissed: false,
      findingSource: null,
      commandStatus: 'failed',
      resultCode: 'FINDING_UNAVAILABLE',
    };
  }

  if (finding.status === 'ignored') {
    return {
      dismissed: false,
      findingSource: finding.source,
      commandStatus: 'no_op',
      resultCode: 'ALREADY_IGNORED',
    };
  }

  if (finding.source === 'dependabot') {
    const target = parseDependabotDismissalTarget({
      sourceId: finding.source_id,
      repoFullName: finding.repo_full_name,
    });

    if (!target) {
      console.warn('Dependabot dismissal skipped because source metadata is invalid', {
        runId: params.message.runId,
        findingId: params.message.findingId,
      });
      return {
        dismissed: false,
        findingSource: finding.source,
        commandStatus: 'failed',
        resultCode: 'INVALID_DISMISS_TARGET',
      };
    }

    const token = await params.gitTokenService.getToken(params.message.installationId);
    const response = await fetch(
      `https://api.github.com/repos/${target.repoOwner}/${target.repoName}/dependabot/alerts/${target.alertNumber}`,

      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'cloudflare-security-sync',
        },
        body: JSON.stringify({
          state: 'dismissed',
          dismissed_reason: params.message.reason,
          dismissed_comment: params.message.comment,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub Dependabot dismissal failed with ${response.status} for finding ${finding.id}`
      );
    }
  }

  const actor = await getDismissalAuditActor(params.db, params.message.actor.id);

  await params.db.transaction(async tx => {
    await tx
      .update(security_findings)
      .set({
        status: 'ignored',
        ignored_reason: params.message.reason,
        ignored_by: actor.email ?? actor.id,
        updated_at: sql`now()`,
      })
      .where(eq(security_findings.id, finding.id));

    await insertSecurityFindingAuditEvent(tx, {
      owner: toAuditOwner(params.message.owner),
      finding: { ...finding, status: 'ignored' },
      actor,
      action: SecurityAuditLogAction.FindingDismissed,
      occurredAt: new Date(),
      eventKey: dismissalEventKey({
        owner: params.message.owner,
        findingId: finding.id,
        commandId: params.message.commandId,
      }),
      sourceContext: SecurityFindingAuditSourceContext.SecuritySync,
      beforeState: { status: finding.status },
      afterState: { status: 'ignored', reason_code: params.message.reason },
      metadata: {
        source: finding.source,
        run_id: params.message.runId,
        command_id: params.message.commandId,
        message_id: params.message.messageId,
        trigger: 'worker_queue',
        reason_code: params.message.reason,
        source_writeback_outcome: finding.source === 'dependabot' ? 'dismissed' : 'not_applicable',
      },
    });
  });

  return {
    dismissed: true,
    findingSource: finding.source,
    commandStatus: 'succeeded',
    resultCode: 'FINDING_DISMISSED',
  };
}
