import { captureException } from '@sentry/nextjs';
import { trackSecurityAgentFullSync } from '../posthog-tracking';
import { db } from '@/lib/drizzle';
import { platform_integrations, agent_configs } from '@kilocode/db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';
import { fetchAllDependabotAlerts } from '../github/dependabot-api';
import { hasSecurityReviewPermissions } from '../github/permissions';
import { parseDependabotAlerts } from '../parsers/dependabot-parser';
import { upsertSecurityFinding } from '../db/security-findings';
import { getSecurityAgentConfig, getSecurityAgentConfigWithStatus } from '../db/security-config';
import {
  getOwnerAutoAnalysisEnabledAt,
  syncAutoAnalysisQueueForFinding,
  type AutoAnalysisQueueSyncResult,
} from '../db/security-analysis';
import { upsertAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import {
  getSlaForSeverity,
  calculateSlaDueAt,
  type SecurityReviewOwner,
  type SyncResult,
} from '../core/types';
import type { Owner } from '@/lib/code-reviews/core';
import { sentryLogger } from '@/lib/utils.server';
import { logSecurityAuditAndWait, SecurityAuditLogAction } from './audit-log-service';

const log = sentryLogger('security-agent:sync', 'info');
const warn = sentryLogger('security-agent:sync', 'warning');
const logError = sentryLogger('security-agent:sync', 'error');

function toAgentConfigOwner(owner: SecurityReviewOwner): Owner {
  if (owner.organizationId) {
    return { type: 'org', id: owner.organizationId, userId: 'system' };
  }
  if (owner.userId) {
    return { type: 'user', id: owner.userId, userId: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

export async function syncDependabotAlertsForRepo(params: {
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  installationId: string;
  repoFullName: string;
}): Promise<SyncResult> {
  const { owner, platformIntegrationId, installationId, repoFullName } = params;
  const repoStartTime = performance.now();

  log(`Starting sync for ${repoFullName}`, { installationId });

  const result: SyncResult = {
    synced: 0,
    created: 0,
    updated: 0,
    errors: 0,
    staleRepos: [],
  };
  const queueSyncTotals: AutoAnalysisQueueSyncResult = {
    enqueueCount: 0,
    eligibleCount: 0,
    boundarySkipCount: 0,
    unknownSeverityCount: 0,
  };

  try {
    const [repoOwner, repoName] = repoFullName.split('/');
    if (!repoOwner || !repoName) {
      throw new Error(`Invalid repo full name: ${repoFullName}`);
    }

    const fetchResult = await fetchAllDependabotAlerts(installationId, repoOwner, repoName);

    if (fetchResult.status === 'repo_not_found') {
      warn(`Repository ${repoFullName} no longer exists, marking as stale`);
      result.staleRepos.push(repoFullName);
      return result;
    }

    if (fetchResult.status === 'alerts_unavailable') {
      warn(`Dependabot alerts unavailable for ${repoFullName}, skipping`);
      return result;
    }

    const alerts = fetchResult.alerts;
    log(`Fetched ${alerts.length} alerts from GitHub for ${repoFullName}`);

    const findings = parseDependabotAlerts(alerts, repoFullName);
    log(`Parsed ${findings.length} findings for ${repoFullName}`);

    const configOwner = toAgentConfigOwner(owner);
    const configWithStatus = await getSecurityAgentConfigWithStatus(configOwner);
    const config = configWithStatus?.config ?? (await getSecurityAgentConfig(configOwner));
    const isAgentEnabled = configWithStatus?.isEnabled ?? false;
    const ownerAutoAnalysisEnabledAt = await getOwnerAutoAnalysisEnabledAt(owner);

    for (const finding of findings) {
      try {
        const slaDays = getSlaForSeverity(config, finding.severity);
        const slaDueAt = calculateSlaDueAt(finding.first_detected_at, slaDays);

        const upsertResult = await upsertSecurityFinding({
          ...finding,
          owner,
          platformIntegrationId,
          repoFullName,
          slaDueAt,
        });

        result.synced++;

        try {
          const queueSyncResult = await syncAutoAnalysisQueueForFinding({
            owner,
            findingId: upsertResult.findingId,
            findingCreatedAt: upsertResult.findingCreatedAt,
            previousStatus: upsertResult.previousStatus,
            currentStatus: finding.status,
            severity: finding.severity,
            isAgentEnabled,
            autoAnalysisEnabled: config.auto_analysis_enabled,
            autoAnalysisMinSeverity: config.auto_analysis_min_severity,
            ownerAutoAnalysisEnabledAt,
          });
          queueSyncTotals.enqueueCount += queueSyncResult.enqueueCount;
          queueSyncTotals.eligibleCount += queueSyncResult.eligibleCount;
          queueSyncTotals.boundarySkipCount += queueSyncResult.boundarySkipCount;
          queueSyncTotals.unknownSeverityCount += queueSyncResult.unknownSeverityCount;
        } catch (error) {
          logError(`Error syncing auto-analysis queue for ${repoFullName}`, {
            error,
            alertNumber: finding.source_id,
            findingId: upsertResult.findingId,
          });
          captureException(error, {
            tags: { operation: 'syncDependabotAlertsForRepo', step: 'syncAutoAnalysisQueue' },
            extra: {
              repoFullName,
              alertNumber: finding.source_id,
              findingId: upsertResult.findingId,
            },
          });
        }
      } catch (error) {
        result.errors++;
        logError(`Error upserting finding for ${repoFullName}`, {
          error,
          alertNumber: finding.source_id,
        });
        captureException(error, {
          tags: { operation: 'syncDependabotAlertsForRepo', step: 'upsertFinding' },
          extra: { repoFullName, alertNumber: finding.source_id },
        });
      }
    }

    const repoDurationMs = Math.round(performance.now() - repoStartTime);
    log(`Repo sync complete`, {
      repo: repoFullName,
      durationMs: repoDurationMs,
      alertsSynced: result.synced,
      errors: result.errors,
      enqueue_count_per_sync: queueSyncTotals.enqueueCount,
      eligible_count_per_sync: queueSyncTotals.eligibleCount,
      boundary_skip_count: queueSyncTotals.boundarySkipCount,
      unknown_severity_count: queueSyncTotals.unknownSeverityCount,
    });

    return result;
  } catch (error) {
    const repoDurationMs = Math.round(performance.now() - repoStartTime);
    logError(`Error syncing ${repoFullName}`, { durationMs: repoDurationMs, error });
    captureException(error, {
      tags: { operation: 'syncDependabotAlertsForRepo' },
      extra: { repoFullName },
    });
    throw error;
  }
}

/**
 * Sync all repos for an owner. Throws the first error if every repo fails.
 * Stale repos (GitHub 404) are returned for pruning.
 */
export async function syncAllReposForOwner(params: {
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  installationId: string;
  repositories: string[];
}): Promise<SyncResult> {
  const { owner, platformIntegrationId, installationId, repositories } = params;

  const totalResult: SyncResult = {
    synced: 0,
    created: 0,
    updated: 0,
    errors: 0,
    staleRepos: [],
  };

  let firstError: Error | null = null;
  let successfulRepos = 0;

  for (const repoFullName of repositories) {
    try {
      const result = await syncDependabotAlertsForRepo({
        owner,
        platformIntegrationId,
        installationId,
        repoFullName,
      });

      totalResult.synced += result.synced;
      totalResult.created += result.created;
      totalResult.updated += result.updated;
      totalResult.errors += result.errors;
      totalResult.staleRepos.push(...result.staleRepos);
      successfulRepos++;
    } catch (error) {
      totalResult.errors++;
      logError(`Failed to sync ${repoFullName}`, { error });
      if (!firstError && error instanceof Error) {
        firstError = error;
      }
    }
  }

  if (successfulRepos === 0 && firstError) {
    throw firstError;
  }

  return totalResult;
}

type EnabledSecurityReviewConfig = {
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  installationId: string;
  repositories: string[];
  /** Maps repo full_name to its numeric ID for pruning stale repos from selected_repository_ids */
  repoNameToId: Map<string, number>;
};

export async function getEnabledSecurityReviewConfigs(): Promise<EnabledSecurityReviewConfig[]> {
  const configs = await db
    .select()
    .from(agent_configs)
    .where(and(eq(agent_configs.agent_type, 'security_scan'), eq(agent_configs.is_enabled, true)));

  const results: EnabledSecurityReviewConfig[] = [];

  for (const config of configs) {
    const orgId = config.owned_by_organization_id;
    const userId = config.owned_by_user_id;

    if (!orgId && !userId) {
      log(`Config ${config.id} has no owner, skipping`);
      continue;
    }

    const ownerCondition = orgId
      ? eq(platform_integrations.owned_by_organization_id, orgId)
      : eq(platform_integrations.owned_by_user_id, userId as string);

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          ownerCondition,
          eq(platform_integrations.platform, 'github'),
          isNotNull(platform_integrations.platform_installation_id)
        )
      )
      .limit(1);

    if (!integration || !integration.platform_installation_id) {
      log(`No GitHub integration found for config ${config.id}, skipping`);
      continue;
    }

    if (!hasSecurityReviewPermissions(integration)) {
      log(`Integration ${integration.id} missing vulnerability_alerts permission, skipping`);
      continue;
    }

    const allRepositories = (integration.repositories || []).filter(
      (r): r is { id: number; full_name: string; name: string; private: boolean } =>
        typeof r.id === 'number' && typeof r.full_name === 'string' && r.full_name.length > 0
    );

    if (allRepositories.length === 0) {
      log(`No repositories found for integration ${integration.id}, skipping`);
      continue;
    }

    const repoNameToId = new Map(allRepositories.map(r => [r.full_name, r.id]));

    const securityConfig = config.config as {
      repository_selection_mode?: 'all' | 'selected';
      selected_repository_ids?: number[];
    };

    let selectedRepos: string[];
    if (
      securityConfig.repository_selection_mode === 'selected' &&
      securityConfig.selected_repository_ids &&
      securityConfig.selected_repository_ids.length > 0
    ) {
      const selectedIds = new Set(securityConfig.selected_repository_ids);
      selectedRepos = allRepositories.filter(r => selectedIds.has(r.id)).map(r => r.full_name);
    } else {
      selectedRepos = allRepositories.map(r => r.full_name);
    }

    if (selectedRepos.length === 0) {
      log(`No selected repositories for config ${config.id}, skipping`);
      continue;
    }

    const owner: SecurityReviewOwner = orgId
      ? { organizationId: orgId }
      : { userId: userId as string };

    results.push({
      owner,
      platformIntegrationId: integration.id,
      installationId: integration.platform_installation_id,
      repositories: selectedRepos,
      repoNameToId,
    });
  }

  return results;
}

const SECURITY_SCAN_AGENT_TYPE = 'security_scan';
const SECURITY_SCAN_PLATFORM = 'github';

/** Remove stale repos from selected_repository_ids when using 'selected' mode. */
async function pruneStaleReposFromConfig(
  owner: SecurityReviewOwner,
  staleRepoNames: string[],
  repoNameToId: Map<string, number>
): Promise<void> {
  if (staleRepoNames.length === 0) return;

  const staleIds = new Set(
    staleRepoNames.map(name => repoNameToId.get(name)).filter((id): id is number => id != null)
  );
  if (staleIds.size === 0) return;

  const agentOwner = toAgentConfigOwner(owner);
  const configWithStatus = await getSecurityAgentConfigWithStatus(agentOwner);
  if (!configWithStatus) return;

  const { config, isEnabled } = configWithStatus;

  if (
    config.repository_selection_mode !== 'selected' ||
    !config.selected_repository_ids ||
    config.selected_repository_ids.length === 0
  ) {
    return;
  }

  const prunedIds = config.selected_repository_ids.filter(id => !staleIds.has(id));
  if (prunedIds.length === config.selected_repository_ids.length) return;

  const prunedRepoNames = staleRepoNames.filter(name => repoNameToId.has(name));
  const removedCount = config.selected_repository_ids.length - prunedIds.length;
  warn(
    `Pruning ${removedCount} stale repo(s) from security config: ${prunedRepoNames.join(', ')}`,
    { owner }
  );

  await upsertAgentConfigForOwner({
    owner: agentOwner,
    agentType: SECURITY_SCAN_AGENT_TYPE,
    platform: SECURITY_SCAN_PLATFORM,
    config: { ...config, selected_repository_ids: prunedIds },
    isEnabled,
    createdBy: 'system-sync-prune',
  });
}

export async function runFullSync(): Promise<{
  totalSynced: number;
  totalErrors: number;
  configsProcessed: number;
}> {
  log('Starting full security alerts sync...');
  const startTime = performance.now();

  const configs = await getEnabledSecurityReviewConfigs();
  log(`Found ${configs.length} enabled configurations`);

  let totalSynced = 0;
  let totalErrors = 0;

  for (const config of configs) {
    try {
      const result = await syncAllReposForOwner(config);
      totalSynced += result.synced;
      totalErrors += result.errors;

      if (result.staleRepos.length > 0) {
        try {
          await pruneStaleReposFromConfig(config.owner, result.staleRepos, config.repoNameToId);
        } catch (pruneError) {
          logError('Failed to prune stale repos from config', {
            error: pruneError,
            staleRepos: result.staleRepos,
            owner: config.owner,
          });
          captureException(pruneError, {
            tags: { operation: 'runFullSync', step: 'pruneStaleRepos' },
            extra: { owner: config.owner, staleRepos: result.staleRepos },
          });
        }
      }

      const ownerId =
        'organizationId' in config.owner
          ? (config.owner.organizationId ?? 'unknown')
          : (config.owner.userId ?? 'unknown');
      await logSecurityAuditAndWait(
        {
          owner: config.owner,
          actor_id: null,
          actor_email: null,
          actor_name: null,
          action: SecurityAuditLogAction.SyncCompleted,
          resource_type: 'agent_config',
          resource_id: ownerId,
          metadata: {
            source: 'system',
            trigger: 'cron',
            synced: result.synced,
            errors: result.errors,
            repoCount: config.repositories.length,
          },
        },
        1500
      );
    } catch (error) {
      totalErrors++;
      captureException(error, {
        tags: { operation: 'runFullSync' },
        extra: { owner: config.owner },
      });
    }
  }

  const duration = Math.round(performance.now() - startTime);
  log(
    `Full sync completed in ${duration}ms: ${totalSynced} alerts synced, ${totalErrors} errors, ${configs.length} configs processed`
  );

  trackSecurityAgentFullSync({
    distinctId: 'system-cron',
    configsProcessed: configs.length,
    totalSynced,
    totalErrors,
    durationMs: duration,
  });

  return {
    totalSynced,
    totalErrors,
    configsProcessed: configs.length,
  };
}
