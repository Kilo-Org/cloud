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
import { getSecurityAgentConfig } from '../db/security-config';
import {
  getSlaForSeverity,
  calculateSlaDueAt,
  type SecurityReviewOwner,
  type SyncResult,
} from '../core/types';
import type { Owner } from '@/lib/code-reviews/core';
import { sentryLogger } from '@/lib/utils.server';

const log = sentryLogger('security-agent:sync', 'info');
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
  };

  try {
    // Parse repo owner and name
    const [repoOwner, repoName] = repoFullName.split('/');
    if (!repoOwner || !repoName) {
      throw new Error(`Invalid repo full name: ${repoFullName}`);
    }

    // Fetch all alerts from Dependabot
    const alerts = await fetchAllDependabotAlerts(installationId, repoOwner, repoName);
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
 * Sync Dependabot alerts for all repositories of an owner
 * If all repositories fail to sync, throws the first error encountered
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

/**
 * Get all enabled security review configurations with their integrations
 */
export async function getEnabledSecurityReviewConfigs(): Promise<
  Array<{
    owner: SecurityReviewOwner;
    platformIntegrationId: string;
    installationId: string;
    repositories: string[];
  }>
> {
  // Get all enabled security_review configs
  const configs = await db
    .select()
    .from(agent_configs)
    .where(and(eq(agent_configs.agent_type, 'security_scan'), eq(agent_configs.is_enabled, true)));

  const results: Array<{
    owner: SecurityReviewOwner;
    platformIntegrationId: string;
    installationId: string;
    repositories: string[];
  }> = [];

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
    });
  }

  return results;
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
