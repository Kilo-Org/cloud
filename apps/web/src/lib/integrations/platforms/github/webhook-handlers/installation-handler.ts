import { NextResponse } from 'next/server';
import {
  bindGitHubIntegrationToCanonicalInstallation,
  type DbTransaction,
  lockGitHubInstallationIdentity,
  observeGitHubInstallationLifecycle,
} from '@/lib/integrations/db/github-installations';
import { effectiveAppTypeCondition } from '@/lib/integrations/db/predicates';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  autoCompleteInstallation,
  deleteGitHubInstallationRecords,
  findConnectedIntegrationByInstallationId,
  suspendIntegration,
  suspendIntegrationForOwner,
  unsuspendIntegration,
  unsuspendIntegrationForOwner,
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
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { bot } from '@/lib/bot';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import type { GitHubAppType } from '../app-selector';

/**
 * GitHub Installation Event Handlers
 * Handles: created, deleted, suspend, unsuspend
 */

/**
 * Admission rule for both automatic repair paths of an installation-created
 * delivery: an association attaches to the canonical installation only when no
 * other live association holds it. A live association is one in PENDING or
 * ACTIVE status that is not disconnected, whether or not it is already bound to
 * a canonical row. Callers already hold the installation identity lock.
 */
async function hasOtherLiveAssociation(
  tx: DbTransaction,
  appType: GitHubAppType,
  installationId: string,
  exceptIntegrationId: string
): Promise<boolean> {
  const [otherAssociation] = await tx
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        effectiveAppTypeCondition(appType),
        eq(platform_integrations.platform_installation_id, installationId),
        inArray(platform_integrations.integration_status, [
          INTEGRATION_STATUS.PENDING,
          INTEGRATION_STATUS.ACTIVE,
        ]),
        isNull(platform_integrations.github_disconnected_at),
        ne(platform_integrations.id, exceptIntegrationId)
      )
    )
    .limit(1);
  return Boolean(otherAssociation);
}

/**
 * Bounds how long a repair transaction waits on a contended installation
 * identity lock, so a delivery that cannot proceed fails fast and GitHub
 * redelivers it. Matches the bounds of connectVerifiedGitHubInstallation.
 */
async function boundRepairTransaction(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '60s'`);
}

export async function handleInstallationCreated(
  payload: InstallationCreatedPayload,
  appType: GitHubAppType
) {
  const { installation, requester } = payload;
  const requesterId = requester?.id?.toString();
  // The delivery's GitHub identities, as attributed by GitHub: the requester
  // recorded on the installation, and the actor that triggered the delivery.
  // A pending request may only be completed by a delivery attributed to the
  // GitHub identity that recorded it.
  const installerAccountIds = [
    ...new Set(
      [requester?.id, payload.sender?.id]
        .filter((value): value is number => typeof value === 'number')
        .map(value => value.toString())
    ),
  ];

  // Build installation data using helper function
  const installationData = buildInstallationData(installation);
  const appTypeCondition = effectiveAppTypeCondition(appType);

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
  const activeRepair = await db.transaction(async tx => {
    await boundRepairTransaction(tx);
    await lockGitHubInstallationIdentity(tx, appType, installationData.installation_id);
    const candidates = await tx
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          appTypeCondition,
          eq(platform_integrations.platform_installation_id, installationData.installation_id),
          eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE),
          isNull(platform_integrations.github_installation_id),
          isNull(platform_integrations.github_disconnected_at)
        )
      );
    if (candidates.length !== 1)
      return { ok: false as const, reason: 'no_sole_candidate' as const };
    const candidate = candidates[0];
    if (!candidate) return { ok: false as const, reason: 'no_sole_candidate' as const };
    if (
      await hasOtherLiveAssociation(tx, appType, installationData.installation_id, candidate.id)
    ) {
      return {
        ok: false as const,
        reason: 'competing_association' as const,
        integrationId: candidate.id,
      };
    }
    await bindGitHubIntegrationToCanonicalInstallation(
      {
        integrationId: candidate.id,
        installationId: installationData.installation_id,
        appType,
      },
      tx
    );
    return { ok: true as const };
  });
  if (!activeRepair.ok && activeRepair.reason === 'competing_association') {
    logExceptInTest('GitHub installation repair declined:', {
      installation_id: installationData.installation_id,
      integration_id: activeRepair.integrationId,
      reason: activeRepair.reason,
    });
  }
  const targetMatches =
    installerAccountIds.length === 0
      ? []
      : await db
          .select()
          .from(platform_integrations)
          .where(
            and(
              eq(platform_integrations.platform, PLATFORM.GITHUB),
              appTypeCondition,
              eq(platform_integrations.platform_account_id, installationData.account_id),
              eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
              isNull(platform_integrations.platform_installation_id),
              inArray(platform_integrations.platform_requester_account_id, installerAccountIds)
            )
          );
  let pending = targetMatches.length === 1 ? targetMatches[0] : undefined;
  if (!pending && installerAccountIds.length > 0) {
    const legacyMatches = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          appTypeCondition,
          inArray(platform_integrations.platform_requester_account_id, installerAccountIds),
          eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
          isNull(platform_integrations.platform_installation_id),
          isNull(platform_integrations.platform_account_id)
        )
      );
    if (legacyMatches.length === 1) pending = legacyMatches[0];
  }
  if (pending) {
    // The decision, the pending-row completion, and the canonical binding run
    // as one serialized unit under the installation identity lock, the same
    // lock connectVerifiedGitHubInstallation and
    // bindGitHubIntegrationToCanonicalInstallation take. Admission therefore
    // holds under concurrency for every writer of this installation identity.
    const completed = await db.transaction(async tx => {
      await lockGitHubInstallationIdentity(tx, appType, installationData.installation_id);
      // A live association may be bound or unbound, so peers are counted by
      // status rather than by whether they already carry a canonical binding.
      if (
        await hasOtherLiveAssociation(tx, appType, installationData.installation_id, pending.id)
      ) {
        return { ok: false as const, reason: 'competing_association' as const };
      }
      const completion = await autoCompleteInstallation(
        {
          integrationId: pending.id,
          installationData,
          existingMetadata: (pending.metadata as Record<string, unknown> | null) ?? {},
          authorizedRequesterAccountIds: installerAccountIds,
        },
        tx
      );
      if (!completion.ok) return completion;
      await bindGitHubIntegrationToCanonicalInstallation(
        {
          integrationId: pending.id,
          installationId: installationData.installation_id,
          appType,
        },
        tx
      );
      return { ok: true as const };
    });
    if (!completed.ok) {
      // The pending request must not be auto-activated: either another tenant
      // already owns this installation, or this delivery is not attributed to
      // the GitHub identity that recorded the request. Leave the row pending
      // so it goes through verified connection confirmation.
      logExceptInTest('GitHub pending installation completion declined:', {
        installation_id: installationData.installation_id,
        account_id: installationData.account_id,
        integration_id: pending.id,
        reason: completed.reason,
      });
      return NextResponse.json(
        { message: 'Installation association requires verified connection confirmation' },
        { status: 200 }
      );
    }
    try {
      const repositories = await fetchGitHubRepositories(installationData.installation_id, appType);
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
  return NextResponse.json({ message: 'Installation recorded' }, { status: 200 });
}

export async function handleInstallationDeleted(
  payload: InstallationDeletedPayload,
  appType: GitHubAppType
) {
  const installationIdStr = payload.installation.id.toString();

  await observeGitHubInstallationLifecycle({
    installationId: installationIdStr,
    appType,
    state: 'deleted',
  });
  if (!isGitHubConnectionManagementEnabled()) {
    await deleteGitHubInstallationRecords(installationIdStr, appType);
  }

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

  return NextResponse.json({ message: 'Installation removed' }, { status: 200 });
}

export async function handleInstallationSuspend(
  payload: InstallationSuspendPayload,
  appType: GitHubAppType
) {
  const installationIdStr = payload.installation.id.toString();
  const integration = await findConnectedIntegrationByInstallationId(
    PLATFORM.GITHUB,
    installationIdStr,
    appType
  );
  await observeGitHubInstallationLifecycle({
    installationId: installationIdStr,
    appType,
    state: 'suspended',
    suspendedAt: new Date().toISOString(),
  });
  if (!isGitHubConnectionManagementEnabled() && integration) {
    const suspendedBy = payload.sender?.login || 'unknown';
    if (integration.owned_by_organization_id) {
      await suspendIntegration(
        integration.owned_by_organization_id,
        PLATFORM.GITHUB,
        suspendedBy,
        appType,
        installationIdStr
      );
    } else if (integration.owned_by_user_id) {
      await suspendIntegrationForOwner(
        { type: 'user', id: integration.owned_by_user_id },
        PLATFORM.GITHUB,
        suspendedBy,
        appType,
        installationIdStr
      );
    }
  }

  return NextResponse.json({ message: 'Installation suspended' }, { status: 200 });
}

export async function handleInstallationUnsuspend(
  payload: InstallationUnsuspendPayload,
  appType: GitHubAppType
) {
  const installationIdStr = payload.installation.id.toString();
  const integration = await findConnectedIntegrationByInstallationId(
    PLATFORM.GITHUB,
    installationIdStr,
    appType
  );
  await observeGitHubInstallationLifecycle({
    installationId: installationIdStr,
    appType,
    state: 'active',
  });
  if (!isGitHubConnectionManagementEnabled() && integration) {
    if (integration.owned_by_organization_id) {
      await unsuspendIntegration(
        integration.owned_by_organization_id,
        PLATFORM.GITHUB,
        appType,
        installationIdStr
      );
    } else if (integration.owned_by_user_id) {
      await unsuspendIntegrationForOwner(
        { type: 'user', id: integration.owned_by_user_id },
        PLATFORM.GITHUB,
        appType,
        installationIdStr
      );
    }
  }

  return NextResponse.json({ message: 'Installation unsuspended' }, { status: 200 });
}
