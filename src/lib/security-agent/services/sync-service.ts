/**
 * Security Reviews - Sync Service
 *
 * Orchestrates syncing Dependabot alerts from GitHub to our database.
 */

import { captureException } from '@sentry/nextjs';
import { trackSecurityAgentFullSync } from '../posthog-tracking';
import { db } from '@/lib/drizzle';
import { platform_integrations, agent_configs } from '@/db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';
import { fetchAllDependabotAlerts } from '../github/dependabot-api';
import { hasSecurityReviewPermissions } from '../github/permissions';
import { parseDependabotAlerts } from '../parsers/dependabot-parser';
import { upsertSecurityFinding } from '../db/security-findings';
import { getSecurityAgentConfig, getSecurityAgentConfigWithStatus } from '../db/security-config';
import { upsertAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import {
  getSlaForSeverity,
  calculateSlaDueAt,
  type SecurityReviewOwner,
  type SyncResult,
} from '../core/types';
import type { Owner } from '@/lib/code-reviews/core';
import { sentryLogger } from '@/lib/utils.server';
import { logSecurityAudit, SecurityAuditLogAction } from './audit-log-service';

const log = sentryLogger('security-agent:sync', 'info');
const warn = sentryLogger('security-agent:sync', 'warning');
const logError = sentryLogger('security-agent:sync', 'error');

/**
 * Convert SecurityReviewOwner to Owner type used by agent_configs
 * The userId field is used for audit purposes; for system operations we use 'system'
 */
function toAgentConfigOwner(owner: SecurityReviewOwner): Owner {
  if (owner.organizationId) {
    return { type: 'org', id: owner.organizationId, userId: 'system' };
  }
  if (owner.userId) {
    return { type: 'user', id: owner.userId, userId: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

/**
 * Sync Dependabot alerts for a single repository
 */
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

  try {
    // Parse repo owner and name
    const [repoOwner, repoName] = repoFullName.split('/');
    if (!repoOwner || !repoName) {
      throw new Error(`Invalid repo full name: ${repoFullName}`);
    }

    // Fetch all alerts from Dependabot
    const fetchResult = await fetchAllDependabotAlerts(installationId, repoOwner, repoName);

    if (fetchResult.status === 'repo_not_found') {
      warn(`Repository ${repoFullName} no longer exists, marking as stale`);
      result.staleRepos.push(repoFullName);
      return result;
    }

    if (fetchResult.status === 'alerts_disabled') {
      log(`Dependabot alerts disabled for ${repoFullName}, skipping`);
      return result;
    }

    const alerts = fetchResult.alerts;
    log(`Fetched ${alerts.length} alerts from GitHub for ${repoFullName}`);

    // Parse alerts to our internal format
    const findings = parseDependabotAlerts(alerts, repoFullName);
    log(`Parsed ${findings.length} findings for ${repoFullName}`);

    // Get SLA config for this owner
    const config = await getSecurityAgentConfig(toAgentConfigOwner(owner));

    // Upsert each finding
    for (const finding of findings) {
      try {
        const slaDays = getSlaForSeverity(config, finding.severity);
        const slaDueAt = calculateSlaDueAt(finding.first_detected_at, slaDays);

        await upsertSecurityFinding({
          ...finding,
          owner,
          platformIntegrationId,
          repoFullName,
          slaDueAt,
        });

        result.synced++;
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
 * Sync Dependabot alerts for all repositories of an owner.
 * If all repositories fail to sync, throws the first error encountered.
 * Stale repos (404 from GitHub) are collected and returned for pruning.
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

  // Track the first error encountered to throw if all repos fail
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

  // If all repositories failed to sync, throw the first error
  // This ensures the frontend gets an error response instead of success
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

/**
 * Get all enabled security review configurations with their integrations
 */
export async function getEnabledSecurityReviewConfigs(): Promise<EnabledSecurityReviewConfig[]> {
  // Get all enabled security_review configs
  const configs = await db
    .select()
    .from(agent_configs)
    .where(and(eq(agent_configs.agent_type, 'security_scan'), eq(agent_configs.is_enabled, true)));

  const results: EnabledSecurityReviewConfig[] = [];

  for (const config of configs) {
    // Validate owner - database constraint ensures one is set, but TypeScript doesn't know
    const orgId = config.owned_by_organization_id;
    const userId = config.owned_by_user_id;

    if (!orgId && !userId) {
      log(`Config ${config.id} has no owner, skipping`);
      continue;
    }

    // Get the platform integration for this owner
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

    // Check if integration has required permissions
    if (!hasSecurityReviewPermissions(integration)) {
      log(`Integration ${integration.id} missing vulnerability_alerts permission, skipping`);
      continue;
    }

    // Get all repositories from integration with valid id and full_name
    const allRepositories = (integration.repositories || []).filter(
      (r): r is { id: number; full_name: string; name: string; private: boolean } =>
        typeof r.id === 'number' && typeof r.full_name === 'string' && r.full_name.length > 0
    );

    if (allRepositories.length === 0) {
      log(`No repositories found for integration ${integration.id}, skipping`);
      continue;
    }

    // Build name-to-id mapping for stale repo pruning
    const repoNameToId = new Map(allRepositories.map(r => [r.full_name, r.id]));

    // Parse the security agent config to get repository selection settings
    const securityConfig = config.config as {
      repository_selection_mode?: 'all' | 'selected';
      selected_repository_ids?: number[];
    };

    // Filter repositories based on selection mode
    let selectedRepos: string[];
    if (
      securityConfig.repository_selection_mode === 'selected' &&
      securityConfig.selected_repository_ids &&
      securityConfig.selected_repository_ids.length > 0
    ) {
      // Only sync selected repositories
      const selectedIds = new Set(securityConfig.selected_repository_ids);
      selectedRepos = allRepositories.filter(r => selectedIds.has(r.id)).map(r => r.full_name);
    } else {
      // Sync all repositories
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

/**
 * Remove stale repos (deleted/transferred on GitHub) from the agent config's
 * selected_repository_ids. Only applies when repository_selection_mode is 'selected'.
 */
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

  // Only prune when using 'selected' mode with explicit repo IDs
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

/**
 * Run a full sync for all enabled security review configurations
 * This is called by the cron job
 */
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

      // Prune stale repos from config so they won't be retried on future syncs
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
      logSecurityAudit({
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
      });
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
