import type { WorkerDb } from '@kilocode/db/client';
import {
  github_app_installations,
  kilocode_users,
  platform_integrations,
  security_findings,
} from '@kilocode/db/schema';
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
import { and, eq, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm';
import type { SecurityDismissMessage } from './index.js';

type FindingDismissalResult = {
  dismissed: boolean;
  findingSource: string | null;
  commandStatus: 'succeeded' | 'failed' | 'no_op';
  resultCode: string;
  lastErrorRedacted?: string;
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

async function timedDismissalStage<T>(
  stage: string,
  context: { commandId: string; findingId: string; runId: string },
  work: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const result = await work();
    console.info('Security Agent dismissal stage completed', {
      stage,
      duration_ms: Date.now() - started,
      command_id: context.commandId,
      finding_id: context.findingId,
      run_id: context.runId,
    });
    return result;
  } catch (error) {
    console.error('Security Agent dismissal stage failed', {
      stage,
      duration_ms: Date.now() - started,
      command_id: context.commandId,
      finding_id: context.findingId,
      run_id: context.runId,
      error_type: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }
}

export async function processSecurityFindingDismissal(params: {
  db: WorkerDb;
  gitTokenService: GitTokenService;
  message: SecurityDismissMessage;
}): Promise<FindingDismissalResult> {
  const stageContext = {
    commandId: params.message.commandId,
    findingId: params.message.findingId,
    runId: params.message.runId,
  };
  const rows = await timedDismissalStage('load_finding', stageContext, () =>
    params.db
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
        platform_integration_id: security_findings.platform_integration_id,
      })
      .from(security_findings)
      .where(eq(security_findings.id, params.message.findingId))
      .limit(1)
  );
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

  let resolvedIntegrationId: string | undefined;
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

    const integrations = await timedDismissalStage('resolve_integration', stageContext, () =>
      params.db
        .select({
          id: platform_integrations.id,
          installationId: platform_integrations.platform_installation_id,
          githubAppType: platform_integrations.github_app_type,
          hasRepositoryAccess: sql<boolean>`(
            (
              COALESCE(${github_app_installations.repository_access}, ${platform_integrations.repository_access}) = 'all'
              AND lower(COALESCE(${github_app_installations.account_login}, ${platform_integrations.platform_account_login})) = lower(${target.repoOwner})
            )
            OR (
              COALESCE(${github_app_installations.repository_access}, ${platform_integrations.repository_access}) = 'selected'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(COALESCE(${github_app_installations.repositories}, ${platform_integrations.repositories}, '[]'::jsonb)) AS repository
                WHERE lower(repository ->> 'full_name') = lower(${finding.repo_full_name})
              )
            )
          )`,
          hasWritePermission: sql<boolean>`COALESCE(${github_app_installations.permissions}, ${platform_integrations.permissions}) ->> 'vulnerability_alerts' = 'write'`,
        })
        .from(platform_integrations)
        .leftJoin(
          github_app_installations,
          eq(platform_integrations.github_installation_id, github_app_installations.id)
        )
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.github_connection_role, 'workflow'),
            eq(platform_integrations.integration_type, 'app'),
            eq(platform_integrations.integration_status, 'active'),
            isNull(platform_integrations.suspended_at),
            isNull(platform_integrations.auth_invalid_at),
            isNull(platform_integrations.github_disconnected_at),
            isNotNull(platform_integrations.platform_installation_id),
            sql`${platform_integrations.platform_installation_id} <> ''`,
            or(
              and(
                isNull(platform_integrations.github_installation_id),
                notExists(
                  params.db
                    .select({ id: github_app_installations.id })
                    .from(github_app_installations)
                    .where(
                      and(
                        eq(
                          github_app_installations.installation_id,
                          platform_integrations.platform_installation_id
                        ),
                        eq(
                          github_app_installations.github_app_type,
                          sql`COALESCE(${platform_integrations.github_app_type}, 'standard')`
                        )
                      )
                    )
                )
              ),
              and(
                eq(github_app_installations.lifecycle_state, 'active'),
                eq(
                  github_app_installations.installation_id,
                  platform_integrations.platform_installation_id
                ),
                eq(
                  github_app_installations.github_app_type,
                  sql`COALESCE(${platform_integrations.github_app_type}, 'standard')`
                ),
                isNull(github_app_installations.suspended_at),
                isNull(github_app_installations.deleted_at),
                isNull(github_app_installations.auth_invalid_at)
              )
            ),
            params.message.owner.organizationId
              ? and(
                  eq(
                    platform_integrations.owned_by_organization_id,
                    params.message.owner.organizationId
                  ),
                  isNull(platform_integrations.owned_by_user_id)
                )
              : and(
                  eq(platform_integrations.owned_by_user_id, params.message.owner.userId ?? ''),
                  isNull(platform_integrations.owned_by_organization_id)
                )
          )
        )
    );
    const repositoryIntegrations = integrations.filter(
      integration => integration.hasRepositoryAccess
    );
    const writableIntegrations = repositoryIntegrations.filter(
      integration => integration.hasWritePermission
    );
    const integration = writableIntegrations[0];
    if (writableIntegrations.length !== 1 || !integration?.installationId) {
      const failure =
        integrations.length === 0
          ? {
              resultCode: 'GITHUB_TOKEN_UNAVAILABLE',
              lastErrorRedacted:
                'No active GitHub workflow integration is available. Re-authorize GitHub App, then retry.',
            }
          : repositoryIntegrations.length === 0
            ? {
                resultCode: 'REPOSITORY_UNAVAILABLE',
                lastErrorRedacted:
                  'GitHub App no longer has access to this repository. Refresh repository access, then retry.',
              }
            : writableIntegrations.length === 0
              ? {
                  resultCode: 'GITHUB_DISMISSAL_PERMISSION_REQUIRED',
                  lastErrorRedacted:
                    'GitHub App needs write access to Dependabot alerts to dismiss this finding. Update its permissions, then retry.',
                }
              : {
                  resultCode: 'GITHUB_INTEGRATION_AMBIGUOUS',
                  lastErrorRedacted:
                    'Multiple GitHub workflow integrations can dismiss this finding. Disconnect the obsolete integration, then retry.',
                };
      return {
        dismissed: false,
        findingSource: finding.source,
        commandStatus: 'failed',
        ...failure,
      };
    }

    const installationId = integration.installationId;
    const writeback = await timedDismissalStage('github_writeback', stageContext, async () => {
      let token: string;
      try {
        // Queued installation IDs and finding links can predate an App reinstall.
        token = await params.gitTokenService.getToken(
          installationId,
          integration.githubAppType ?? 'standard',
          integration.id
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'GitHubInstallationAccessDeniedError') {
          return {
            dismissed: false,
            findingSource: finding.source,
            commandStatus: 'failed' as const,
            resultCode: 'GITHUB_TOKEN_UNAVAILABLE',
            lastErrorRedacted:
              'GitHub App installation is no longer active. Re-authorize GitHub App, then retry.',
          };
        }
        throw error;
      }
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
      return null;
    });
    if (writeback) return writeback;
    resolvedIntegrationId = integration.id;
  }

  const actor = await timedDismissalStage('load_actor', stageContext, () =>
    getDismissalAuditActor(params.db, params.message.actor.id)
  );

  await timedDismissalStage('persist_dismissal', stageContext, () =>
    params.db.transaction(async tx => {
      await tx
        .update(security_findings)
        .set({
          status: 'ignored',
          ignored_reason: params.message.reason,
          ignored_by: actor.email ?? actor.id,
          ...(resolvedIntegrationId ? { platform_integration_id: resolvedIntegrationId } : {}),
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
          source_writeback_outcome:
            finding.source === 'dependabot' ? 'dismissed' : 'not_applicable',
        },
      });
    })
  );

  return {
    dismissed: true,
    findingSource: finding.source,
    commandStatus: 'succeeded',
    resultCode: 'FINDING_DISMISSED',
  };
}
