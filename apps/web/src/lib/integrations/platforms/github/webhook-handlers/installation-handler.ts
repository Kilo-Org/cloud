import { NextResponse } from 'next/server';
import { observeGitHubInstallationLifecycle } from '@/lib/integrations/db/github-installations';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import {
  autoCompleteInstallation,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { fetchGitHubRepositories } from '../adapter';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import { isGitHubConnectionManagementEnabled } from '@/lib/integrations/github/multiple-installations';
import type { IntegrationPermissions } from '@/lib/integrations/core/types';
import type {
  InstallationCreatedPayload,
  InstallationDeletedPayload,
  InstallationSuspendPayload,
  InstallationUnsuspendPayload,
} from '../webhook-schemas';
import { buildInstallationData } from '../webhook-helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { bot } from '@/lib/bot';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import type { GitHubAppType } from '../app-selector';

/**
 * GitHub Installation Event Handlers
 * Handles: created, deleted, suspend, unsuspend
 */

export async function handleInstallationCreated(
  payload: InstallationCreatedPayload,
  appType: GitHubAppType
) {
  const { installation, requester } = payload;
  const requesterId = requester?.id?.toString();

  // Build installation data using helper function
  const installationData = buildInstallationData(installation);

  logExceptInTest('GitHub App installation created:', {
    installation_id: installationData.installation_id,
    account_id: installationData.account_id,
    account_login: installationData.account_login,
    requester_id: requesterId,
    requester_login: requester?.login,
  });

  await observeGitHubInstallationLifecycle({
    installationId: installationData.installation_id,
    appType,
    state: 'active',
    accountId: installationData.account_id,
    accountLogin: installationData.account_login,
    permissions: installationData.permissions as IntegrationPermissions,
    scopes: installationData.events,
    repositoryAccess: installationData.repository_selection,
  });
  if (!isGitHubConnectionManagementEnabled()) {
    const targetMatches = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          eq(platform_integrations.github_app_type, appType),
          eq(platform_integrations.platform_account_id, installationData.account_id),
          eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
          isNull(platform_integrations.platform_installation_id)
        )
      );
    let pending = targetMatches.length === 1 ? targetMatches[0] : undefined;
    if (!pending && requesterId) {
      const legacyMatches = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.GITHUB),
            eq(platform_integrations.github_app_type, appType),
            eq(platform_integrations.platform_requester_account_id, requesterId),
            eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
            isNull(platform_integrations.platform_installation_id),
            isNull(platform_integrations.platform_account_id)
          )
        );
      if (legacyMatches.length === 1) pending = legacyMatches[0];
    }
    if (pending) {
      await autoCompleteInstallation({
        integrationId: pending.id,
        installationData,
        existingMetadata: (pending.metadata as Record<string, unknown> | null) ?? {},
      });
      try {
        const repositories = await fetchGitHubRepositories(
          installationData.installation_id,
          appType
        );
        await updateRepositoriesForIntegration(pending.id, repositories);
      } catch (error) {
        captureException(error, { tags: { operation: 'github-pending-repository-sync' } });
      }
      return NextResponse.json(
        {
          message: 'Installation completed',
          owned_by_organization_id: pending.owned_by_organization_id,
          owned_by_user_id: pending.owned_by_user_id,
        },
        { status: 200 }
      );
    }
  }
  return NextResponse.json({ message: 'Installation recorded' }, { status: 200 });
}

export async function handleInstallationDeleted(
  payload: InstallationDeletedPayload,
  appType: GitHubAppType
) {
  const installationIdStr = payload.installation.id.toString();

  try {
    // The bot identity store has no app-type dimension and the lite app has no
    // bot-link flow, so only the standard app unlinks team bot identities.
    if (appType !== 'lite') {
      await bot.initialize();
      await unlinkTeamKiloUsers(bot.getState(), PLATFORM.GITHUB, installationIdStr);
    }
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'github-installation-deleted-unlink' },
      extra: { installationId: installationIdStr },
    });
  }

  await observeGitHubInstallationLifecycle({
    installationId: installationIdStr,
    appType,
    state: 'deleted',
  });

  return NextResponse.json({ message: 'Installation removed' }, { status: 200 });
}

export async function handleInstallationSuspend(
  payload: InstallationSuspendPayload,
  appType: GitHubAppType
) {
  const installationIdStr = payload.installation.id.toString();
  await observeGitHubInstallationLifecycle({
    installationId: installationIdStr,
    appType,
    state: 'suspended',
    suspendedAt: new Date().toISOString(),
  });

  return NextResponse.json({ message: 'Installation suspended' }, { status: 200 });
}

export async function handleInstallationUnsuspend(
  payload: InstallationUnsuspendPayload,
  appType: GitHubAppType
) {
  const installationIdStr = payload.installation.id.toString();
  await observeGitHubInstallationLifecycle({
    installationId: installationIdStr,
    appType,
    state: 'active',
  });

  return NextResponse.json({ message: 'Installation unsuspended' }, { status: 200 });
}
