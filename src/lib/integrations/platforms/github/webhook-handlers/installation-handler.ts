import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import {
  findIntegrationByInstallationId,
  suspendIntegration,
  unsuspendIntegration,
  deleteIntegration,
  autoCompleteInstallation,
  suspendIntegrationForOwner,
  unsuspendIntegrationForOwner,
  deleteIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { fetchGitHubRepositories } from '../adapter';
import type {
  InstallationCreatedPayload,
  InstallationDeletedPayload,
  InstallationSuspendPayload,
  InstallationUnsuspendPayload,
} from '../webhook-schemas';
import { buildInstallationData } from '../webhook-helpers';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * GitHub Installation Event Handlers
 * Handles: created, deleted, suspend, unsuspend
 */

export async function handleInstallationCreated(payload: InstallationCreatedPayload) {
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

  // Simple 1:1 mapping: Find THE pending installation by this requester
  if (!requesterId) {
    // No requester ID - let callback handle (direct install flow)
    logExceptInTest('No requester ID - callback will handle');
    return NextResponse.json({ message: 'Installation recorded' }, { status: 200 });
  }

  // Direct indexed query - O(1) lookup using platform_requester_account_id column
  const [pending] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.platform_requester_account_id, requesterId),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
        isNull(platform_integrations.platform_installation_id)
      )
    )
    .limit(1);

  if (!pending) {
    // No pending - normal install via callback will handle
    logExceptInTest('No pending installation found - callback will handle');
    return NextResponse.json({ message: 'Installation recorded' }, { status: 200 });
  }

  const metadata = pending.metadata as Record<string, unknown> | null;

  // Auto-complete the installation immediately
  await autoCompleteInstallation({
    integrationId: pending.id,
    installationData,
    existingMetadata: metadata || {},
  });

  logExceptInTest('Auto-completed pending installation', {
    integration_id: pending.id,
    owned_by_organization_id: pending.owned_by_organization_id,
    owned_by_user_id: pending.owned_by_user_id,
    installation_id: installationData.installation_id,
  });

  // Auto-sync repositories on installation
  try {
    const appType = pending.github_app_type || 'standard';
    const repos = await fetchGitHubRepositories(installationData.installation_id, appType);
    await updateRepositoriesForIntegration(pending.id, repos);
    logExceptInTest('Auto-synced repositories on installation', {
      integration_id: pending.id,
      repo_count: repos.length,
    });
  } catch (error) {
    // Non-fatal - user can manually refresh later
    console.error('Failed to auto-sync repositories on installation:', error);
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

export async function handleInstallationDeleted(payload: InstallationDeletedPayload) {
  const installationIdStr = payload.installation.id.toString();

  // Find and delete the integration (whether completed or pending)
  const integrationToDelete = await findIntegrationByInstallationId(
    PLATFORM.GITHUB,
    installationIdStr
  );

  if (integrationToDelete) {
    // Determine owner from the integration record
    if (integrationToDelete.owned_by_organization_id) {
      await deleteIntegration(integrationToDelete.owned_by_organization_id, PLATFORM.GITHUB);
      logExceptInTest('Deleted organization installation:', {
        installation_id: installationIdStr,
        owned_by_organization_id: integrationToDelete.owned_by_organization_id,
      });
    } else if (integrationToDelete.owned_by_user_id) {
      await deleteIntegrationForOwner(
        { type: 'user', id: integrationToDelete.owned_by_user_id },
        PLATFORM.GITHUB
      );
      logExceptInTest('Deleted user installation:', {
        installation_id: installationIdStr,
        owned_by_user_id: integrationToDelete.owned_by_user_id,
      });
    } else {
      console.error('Integration found but has no owner:', integrationToDelete.id);
    }
  }

  return NextResponse.json({ message: 'Installation removed' }, { status: 200 });
}

export async function handleInstallationSuspend(payload: InstallationSuspendPayload) {
  const integrationToSuspend = await findIntegrationByInstallationId(
    PLATFORM.GITHUB,
    payload.installation.id.toString()
  );

  if (integrationToSuspend) {
    const suspendedBy = payload.sender?.login || 'unknown';

    // Determine owner from the integration record
    if (integrationToSuspend.owned_by_organization_id) {
      await suspendIntegration(
        integrationToSuspend.owned_by_organization_id,
        PLATFORM.GITHUB,
        suspendedBy
      );
      logExceptInTest('GitHub App suspended (organization):', {
        installation_id: payload.installation.id,
        owned_by_organization_id: integrationToSuspend.owned_by_organization_id,
      });
    } else if (integrationToSuspend.owned_by_user_id) {
      await suspendIntegrationForOwner(
        { type: 'user', id: integrationToSuspend.owned_by_user_id },
        PLATFORM.GITHUB,
        suspendedBy
      );
      logExceptInTest('GitHub App suspended (user):', {
        installation_id: payload.installation.id,
        owned_by_user_id: integrationToSuspend.owned_by_user_id,
      });
    } else {
      console.error('Integration found but has no owner:', integrationToSuspend.id);
    }
  }

  return NextResponse.json({ message: 'Installation suspended' }, { status: 200 });
}

export async function handleInstallationUnsuspend(payload: InstallationUnsuspendPayload) {
  const integrationToUnsuspend = await findIntegrationByInstallationId(
    PLATFORM.GITHUB,
    payload.installation.id.toString()
  );

  if (integrationToUnsuspend) {
    // Determine owner from the integration record
    if (integrationToUnsuspend.owned_by_organization_id) {
      await unsuspendIntegration(integrationToUnsuspend.owned_by_organization_id, PLATFORM.GITHUB);
      logExceptInTest('GitHub App unsuspended (organization):', {
        installation_id: payload.installation.id,
        owned_by_organization_id: integrationToUnsuspend.owned_by_organization_id,
      });
    } else if (integrationToUnsuspend.owned_by_user_id) {
      await unsuspendIntegrationForOwner(
        { type: 'user', id: integrationToUnsuspend.owned_by_user_id },
        PLATFORM.GITHUB
      );
      logExceptInTest('GitHub App unsuspended (user):', {
        installation_id: payload.installation.id,
        owned_by_user_id: integrationToUnsuspend.owned_by_user_id,
      });
    } else {
      console.error('Integration found but has no owner:', integrationToUnsuspend.id);
    }
  }

  return NextResponse.json({ message: 'Installation unsuspended' }, { status: 200 });
}
