import type { WorkerDb } from '@kilocode/db/client';
import { security_audit_log, security_findings } from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import { parseDependabotDismissalTarget } from '@kilocode/worker-utils/dependabot-dismissal-target';
import { eq, sql } from 'drizzle-orm';
import type { SecurityDismissMessage } from './index.js';

type FindingDismissalResult = {
  dismissed: boolean;
  findingSource: string | null;
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
      status: security_findings.status,
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
    return { dismissed: false, findingSource: null };
  }

  if (finding.status === 'ignored') {
    return { dismissed: false, findingSource: finding.source };
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
      return { dismissed: false, findingSource: finding.source };
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

  await params.db.transaction(async tx => {
    await tx
      .update(security_findings)
      .set({
        status: 'ignored',
        ignored_reason: params.message.reason,
        ignored_by: params.message.actor.email ?? params.message.actor.id,
        updated_at: sql`now()`,
      })
      .where(eq(security_findings.id, finding.id));

    await tx.insert(security_audit_log).values({
      owned_by_organization_id: params.message.owner.organizationId ?? null,
      owned_by_user_id: params.message.owner.userId ?? null,
      actor_id: params.message.actor.id,
      actor_email: params.message.actor.email ?? null,
      actor_name: params.message.actor.name ?? null,
      action: SecurityAuditLogAction.FindingDismissed,
      resource_type: 'security_finding',
      resource_id: finding.id,
      before_state: { status: finding.status },
      after_state: { status: 'ignored', ignoredReason: params.message.reason },
      metadata: {
        source: finding.source,
        runId: params.message.runId,
        messageId: params.message.messageId,
        trigger: 'worker_queue',
      },
    });
  });

  return { dismissed: true, findingSource: finding.source };
}
