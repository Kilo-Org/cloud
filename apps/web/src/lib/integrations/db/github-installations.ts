import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type {
  IntegrationPermissions,
  Owner,
  PlatformRepository,
} from '@/lib/integrations/core/types';
import {
  github_app_installations,
  github_installation_webhook_receipts,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  canOrganizationCreateSharedGitHubConnection,
  canOrganizationUseMultipleGitHubInstallations,
} from '@/lib/integrations/github/multiple-installations';
import { lockProviderOAuthOwnerRow } from '@/lib/integrations/provider-oauth-attempts';
import { parsePlatformRepositoryCache } from '@/lib/integrations/core/schemas';
import {
  cancelActiveCodeReviewsForIntegration,
  settleCancelledReviews,
} from '@/lib/code-reviews/db/code-reviews';

export type DbTransaction = DrizzleTransaction;

/**
 * Serializes every writer that must reason about the full set of tenant
 * associations for one GitHub App installation identity. Callers must run
 * inside a transaction; the lock is released at commit/rollback.
 */
export async function lockGitHubInstallationIdentity(
  tx: DbTransaction,
  appType: 'standard' | 'lite',
  installationId: string
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${appType}:${installationId}`}))`);
}

export type VerifiedGitHubInstallationData = {
  platformInstallationId: string;
  platformAccountId: string;
  platformAccountLogin: string;
  permissions: IntegrationPermissions | null;
  scopes: string[];
  repositoryAccess: string;
  repositories: PlatformRepository[] | null;
  installedAt: string;
  githubAppType: 'standard' | 'lite';
  kiloUserId: string;
  githubUserId: string;
  accountType: 'Organization' | 'User';
  pendingIntegrationId?: string;
};

export type ConnectVerifiedGitHubInstallationResult =
  | { ok: true; integrationId: string }
  | {
      ok: false;
      reason:
        | 'claimed_by_other_owner'
        | 'shared_installation_disabled'
        | 'incompatible_workflow'
        | 'retryable_conflict'
        | 'multiple_installations_disabled'
        | 'installation_unavailable';
    };

function isCanonicalInstallationId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? eq(platform_integrations.owned_by_user_id, owner.id)
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}

export function effectiveAppTypeCondition(appType: 'standard' | 'lite') {
  return appType === 'standard'
    ? or(
        eq(platform_integrations.github_app_type, 'standard'),
        isNull(platform_integrations.github_app_type)
      )
    : eq(platform_integrations.github_app_type, 'lite');
}

export async function connectVerifiedGitHubInstallation(
  owner: Owner,
  data: VerifiedGitHubInstallationData,
  transaction?: DbTransaction
): Promise<ConnectVerifiedGitHubInstallationResult> {
  const execute = async (tx: DbTransaction): Promise<ConnectVerifiedGitHubInstallationResult> => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '60s'`);
    if (!isCanonicalInstallationId(data.platformInstallationId)) {
      return { ok: false, reason: 'installation_unavailable' };
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${data.githubAppType}:${data.platformInstallationId}`}))`
    );
    const requiresOwnerCardinalityLock =
      owner.type === 'org' && !canOrganizationUseMultipleGitHubInstallations(owner.id);
    if (requiresOwnerCardinalityLock) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${owner.type}:${owner.id}`}))`);
    }
    const participantRows = await tx
      .select({
        userId: platform_integrations.owned_by_user_id,
        organizationId: platform_integrations.owned_by_organization_id,
      })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          eq(platform_integrations.platform_installation_id, data.platformInstallationId),
          effectiveAppTypeCondition(data.githubAppType)
        )
      );
    const participants = new Map<string, Owner>();
    participants.set(`${owner.type}:${owner.id}`, owner);
    for (const participant of participantRows) {
      const participantOwner: Owner | null = participant.organizationId
        ? { type: 'org', id: participant.organizationId }
        : participant.userId
          ? { type: 'user', id: participant.userId }
          : null;
      if (participantOwner) {
        participants.set(`${participantOwner.type}:${participantOwner.id}`, participantOwner);
      }
    }
    for (const participant of [...participants.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await lockProviderOAuthOwnerRow(tx, participant[1]);
    }
    if (requiresOwnerCardinalityLock) {
      const ownerIntegrations = await tx
        .select({
          installationId: platform_integrations.platform_installation_id,
          appType: platform_integrations.github_app_type,
        })
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.owned_by_organization_id, owner.id),
            eq(platform_integrations.platform, PLATFORM.GITHUB),
            // A locally disconnected connection has relinquished its slot; it
            // must not block attaching a different installation.
            isNull(platform_integrations.github_disconnected_at)
          )
        );
      const hasAnotherInstallation = ownerIntegrations.some(
        integration =>
          integration.installationId !== null &&
          (integration.installationId !== data.platformInstallationId ||
            (integration.appType ?? 'standard') !== data.githubAppType)
      );
      if (hasAnotherInstallation) {
        return { ok: false, reason: 'multiple_installations_disabled' };
      }
    }

    await tx
      .insert(github_app_installations)
      .values({
        github_app_type: data.githubAppType,
        installation_id: data.platformInstallationId,
        account_id: data.platformAccountId,
        account_login: data.platformAccountLogin,
        account_type: data.accountType,
        permissions: data.permissions,
        scopes: data.scopes,
        repository_access: data.repositoryAccess,
        repositories: data.repositories,
        repositories_synced_at: new Date().toISOString(),
        lifecycle_state: 'active',
        observed_at: new Date().toISOString(),
      })
      .onConflictDoNothing();

    const [canonical] = await tx
      .select()
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, data.githubAppType),
          eq(github_app_installations.installation_id, data.platformInstallationId)
        )
      )
      .for('update');
    if (
      !canonical ||
      canonical.lifecycle_state === 'deleted' ||
      canonical.lifecycle_state === 'suspended'
    ) {
      return { ok: false, reason: 'installation_unavailable' };
    }
    const now = new Date().toISOString();
    await tx
      .update(github_app_installations)
      .set({
        account_id: data.platformAccountId,
        account_login: data.platformAccountLogin,
        account_type: data.accountType,
        permissions: data.permissions,
        scopes: data.scopes,
        repository_access: data.repositoryAccess,
        repositories: data.repositories,
        repositories_synced_at: now,
        lifecycle_state: 'active',
        suspended_at: null,
        auth_invalid_at: null,
        auth_invalid_reason: null,
        observed_at: now,
        revision: sql`${github_app_installations.revision} + 1`,
        updated_at: now,
      })
      .where(eq(github_app_installations.id, canonical.id));

    const existingMatches = await tx
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          eq(platform_integrations.platform_installation_id, data.platformInstallationId),
          effectiveAppTypeCondition(data.githubAppType)
        )
      )
      .for('update');

    if (
      existingMatches.some(
        association =>
          association.github_installation_id !== null &&
          association.github_installation_id !== canonical.id
      )
    ) {
      return { ok: false, reason: 'installation_unavailable' };
    }
    const ownerMatches = existingMatches.filter(
      association =>
        (owner.type === 'user' && association.owned_by_user_id === owner.id) ||
        (owner.type === 'org' && association.owned_by_organization_id === owner.id)
    );
    if (ownerMatches.length > 1) {
      return { ok: false, reason: 'installation_unavailable' };
    }
    const existing = ownerMatches[0];
    const otherOwnerAssociations = existingMatches.filter(
      association => association.id !== existing?.id
    );

    if (
      existing &&
      otherOwnerAssociations.length > 0 &&
      existing.github_installation_id !== canonical.id
    ) {
      return { ok: false, reason: 'installation_unavailable' };
    }

    if (existing && existing.github_connection_role === null) {
      return { ok: false, reason: 'installation_unavailable' };
    }
    const role: 'workflow' | 'agent_only' =
      existing?.github_connection_role ??
      (otherOwnerAssociations.length > 0 ? 'agent_only' : 'workflow');
    if (!existing && role === 'agent_only' && owner.type !== 'org') {
      return { ok: false, reason: 'claimed_by_other_owner' };
    }

    const requiresSharingAdmission =
      role === 'agent_only' && (!existing || existing.github_disconnected_at !== null);
    if (requiresSharingAdmission) {
      if (owner.type !== 'org' || !canOrganizationCreateSharedGitHubConnection(owner.id)) {
        return { ok: false, reason: 'shared_installation_disabled' };
      }
      if (
        otherOwnerAssociations.some(
          association => !association.github_installation_id || !association.github_connection_role
        )
      ) {
        return { ok: false, reason: 'installation_unavailable' };
      }
    }

    const values = {
      github_installation_id: canonical.id,
      github_connection_role: role,
      platform_account_id: data.platformAccountId,
      platform_account_login: data.platformAccountLogin,
      permissions: data.permissions,
      scopes: data.scopes,
      repository_access: data.repositoryAccess,
      repositories: data.repositories,
      repositories_synced_at: now,
      installed_at: data.installedAt,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      suspended_at: null,
      suspended_by: null,
      auth_invalid_at: null,
      auth_invalid_reason: null,
      github_authorized_by_user_id: data.kiloUserId,
      github_authorized_user_id: data.githubUserId,
      github_authorized_at: now,
      updated_at: now,
    };
    if (existing) {
      await tx
        .update(platform_integrations)
        .set({ ...values, github_disconnected_at: null })
        .where(eq(platform_integrations.id, existing.id));
      return { ok: true, integrationId: existing.id };
    }

    const pendingCandidates = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          data.pendingIntegrationId
            ? eq(platform_integrations.id, data.pendingIntegrationId)
            : undefined,
          ownerCondition(owner),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          effectiveAppTypeCondition(data.githubAppType),
          eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING),
          isNull(platform_integrations.platform_installation_id),
          data.pendingIntegrationId
            ? undefined
            : eq(platform_integrations.platform_account_id, data.platformAccountId)
        )
      )
      .limit(2)
      .for('update');
    const pending = pendingCandidates.length === 1 ? pendingCandidates[0] : undefined;
    const [created] = pending
      ? await tx
          .update(platform_integrations)
          .set({
            ...values,
            platform_installation_id: data.platformInstallationId,
            github_app_type: data.githubAppType,
            github_disconnected_at: null,
          })
          .where(eq(platform_integrations.id, pending.id))
          .returning({ id: platform_integrations.id })
      : await tx
          .insert(platform_integrations)
          .values({
            ...values,
            owned_by_user_id: owner.type === 'user' ? owner.id : null,
            owned_by_organization_id: owner.type === 'org' ? owner.id : null,
            platform: PLATFORM.GITHUB,
            integration_type: 'app',
            platform_installation_id: data.platformInstallationId,
            github_app_type: data.githubAppType,
          })
          .returning({ id: platform_integrations.id });
    if (!created) return { ok: false, reason: 'installation_unavailable' };
    return { ok: true, integrationId: created.id };
  };

  try {
    return await (transaction ? execute(transaction) : db.transaction(execute));
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'cause' in error
        ? (error.cause as { code?: string } | undefined)?.code
        : (error as { code?: string } | undefined)?.code;
    if (code === '55P03' || code === '40P01' || code === '57014') {
      return { ok: false, reason: 'retryable_conflict' };
    }
    throw error;
  }
}

export async function disconnectGitHubInstallation(
  owner: Owner,
  integrationId: string
): Promise<void> {
  const cancelledReviews = await db.transaction(async tx => {
    const [integration] = await tx
      .select({
        installationId: platform_integrations.platform_installation_id,
        appType: platform_integrations.github_app_type,
        canonicalId: platform_integrations.github_installation_id,
      })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, integrationId),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          ownerCondition(owner)
        )
      )
      .limit(1);
    if (!integration?.installationId) throw new Error('GitHub connection not found');
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${integration.appType ?? 'standard'}:${integration.installationId}`}))`
    );
    const disconnected = await tx
      .update(platform_integrations)
      .set({
        github_disconnected_at: new Date().toISOString(),
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        suspended_by: 'local_disconnect',
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(platform_integrations.id, integrationId),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          ownerCondition(owner)
        )
      )
      .returning({ id: platform_integrations.id });
    if (disconnected.length !== 1) throw new Error('GitHub connection not found');
    // Terminalize this association's own active review work as part of the
    // same disconnect: otherwise a queued/running review keeps its dispatch
    // reservation and never reaches a terminal status, leaving it (and the
    // reservation) permanently stuck once the association is gone.
    const cancelled = await cancelActiveCodeReviewsForIntegration(
      { owner, platform: PLATFORM.GITHUB, integrationId },
      tx
    );
    return cancelled;
  });
  // Settle only after this transaction has committed — see the
  // settleCancelledReviews doc comment for why.
  await settleCancelledReviews(cancelledReviews, 'user_cancelled');
}

export async function uninstallExclusiveGitHubInstallation(input: {
  owner: Owner;
  integrationId: string;
  deleteUpstream: (installationId: string, appType: 'standard' | 'lite') => Promise<void>;
}): Promise<void> {
  const cancelledReviews = await db.transaction(async tx => {
    const [identity] = await tx
      .select({
        installationId: platform_integrations.platform_installation_id,
        appType: platform_integrations.github_app_type,
        role: platform_integrations.github_connection_role,
      })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          ownerCondition(input.owner)
        )
      )
      .limit(1);
    if (!identity?.installationId) throw new Error('GitHub connection not found');
    if (identity.role !== 'workflow')
      throw new Error('GitHub installation must be disconnected locally');
    const appType = identity.appType ?? 'standard';
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${appType}:${identity.installationId}`}))`
    );
    const [lockedTarget] = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          ownerCondition(input.owner)
        )
      )
      .for('update');
    if (!lockedTarget) throw new Error('GitHub connection not found');
    // Legacy associations can be unbound, so lock and check siblings by upstream identity.
    await tx
      .select({ id: github_app_installations.id })
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.installation_id, identity.installationId),
          eq(github_app_installations.github_app_type, appType)
        )
      )
      .for('update');
    const otherConnectedAssociations = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          eq(platform_integrations.platform_installation_id, identity.installationId),
          effectiveAppTypeCondition(appType),
          isNull(platform_integrations.github_disconnected_at),
          ne(platform_integrations.id, input.integrationId)
        )
      )
      .for('update');
    if (otherConnectedAssociations.length > 0) {
      throw new Error('GitHub installation must be disconnected locally');
    }

    // Terminalize this association's own active review work before it is
    // deleted below: the FK is ON DELETE SET NULL, not cascade, so without
    // this a still-queued/running review would just lose its integration
    // reference and never reach a terminal status.
    const cancelled = await cancelActiveCodeReviewsForIntegration(
      { owner: input.owner, platform: PLATFORM.GITHUB, integrationId: input.integrationId },
      tx
    );

    await input.deleteUpstream(identity.installationId, appType);
    await observeGitHubInstallationLifecycle(
      { installationId: identity.installationId, appType, state: 'deleted' },
      tx
    );
    await tx.delete(platform_integrations).where(eq(platform_integrations.id, input.integrationId));
    return cancelled;
  });
  // Settle only after this transaction has committed — see the
  // settleCancelledReviews doc comment for why.
  await settleCancelledReviews(cancelledReviews, 'user_cancelled');
}

export async function observeGitHubInstallationLifecycle(
  input: {
    installationId: string;
    appType: 'standard' | 'lite';
    state: 'active' | 'suspended' | 'deleted';
    suspendedAt?: string | null;
    accountId?: string;
    accountLogin?: string;
    accountType?: 'Organization' | 'User';
    permissions?: IntegrationPermissions | null;
    scopes?: string[];
    repositoryAccess?: string;
  },
  transaction?: DbTransaction
) {
  const now = new Date().toISOString();
  const execute = async (tx: DbTransaction) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.appType}:${input.installationId}`}))`
    );
    const [existing] = await tx
      .select({ id: github_app_installations.id, state: github_app_installations.lifecycle_state })
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, input.appType),
          eq(github_app_installations.installation_id, input.installationId)
        )
      )
      .for('update');
    if (existing?.state === 'deleted' && input.state !== 'deleted') return;
    const [canonical] = await tx
      .insert(github_app_installations)
      .values({
        github_app_type: input.appType,
        installation_id: input.installationId,
        account_id: input.accountId,
        account_login: input.accountLogin,
        account_type: input.accountType,
        permissions: input.permissions,
        scopes: input.scopes,
        repository_access: input.repositoryAccess,
        lifecycle_state: input.state,
        suspended_at: input.suspendedAt ?? null,
        deleted_at: input.state === 'deleted' ? now : null,
        observed_at: now,
      })
      .onConflictDoUpdate({
        target: [
          github_app_installations.github_app_type,
          github_app_installations.installation_id,
        ],
        set: {
          account_id: input.accountId ?? sql`${github_app_installations.account_id}`,
          account_login: input.accountLogin ?? sql`${github_app_installations.account_login}`,
          account_type: input.accountType ?? sql`${github_app_installations.account_type}`,
          permissions: input.permissions ?? sql`${github_app_installations.permissions}`,
          scopes: input.scopes ?? sql`${github_app_installations.scopes}`,
          repository_access:
            input.repositoryAccess ?? sql`${github_app_installations.repository_access}`,
          lifecycle_state: input.state,
          suspended_at: input.suspendedAt ?? null,
          deleted_at: input.state === 'deleted' ? now : null,
          observed_at: now,
          revision: sql`${github_app_installations.revision} + 1`,
          updated_at: now,
        },
      })
      .returning({ id: github_app_installations.id });
    if (!canonical) throw new Error('Canonical GitHub installation lifecycle update failed');
    const associationCondition = or(
      eq(platform_integrations.github_installation_id, canonical.id),
      and(
        isNull(platform_integrations.github_installation_id),
        eq(platform_integrations.platform_installation_id, input.installationId),
        effectiveAppTypeCondition(input.appType)
      )
    );
    if (input.state !== 'active') {
      await tx
        .update(platform_integrations)
        .set({
          integration_status: INTEGRATION_STATUS.SUSPENDED,
          suspended_at: now,
          suspended_by: `github_${input.state}`,
          updated_at: now,
        })
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.GITHUB),
            associationCondition,
            isNull(platform_integrations.github_disconnected_at)
          )
        );
    } else {
      await tx
        .update(platform_integrations)
        .set({
          integration_status: INTEGRATION_STATUS.ACTIVE,
          suspended_at: null,
          suspended_by: null,
          updated_at: now,
        })
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.GITHUB),
            associationCondition,
            isNull(platform_integrations.github_disconnected_at),
            eq(platform_integrations.suspended_by, 'github_suspended')
          )
        );
    }
  };
  return transaction ? execute(transaction) : db.transaction(execute);
}

export async function updateGitHubInstallationRepositories(input: {
  installationId: string;
  appType: 'standard' | 'lite';
  repositoriesAdded?: PlatformRepository[];
  repositoryIdsRemoved?: number[];
}) {
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.appType}:${input.installationId}`}))`
    );
    const [canonical] = await tx
      .select()
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, input.appType),
          eq(github_app_installations.installation_id, input.installationId)
        )
      )
      .for('update');
    if (!canonical) {
      const legacy = await tx
        .select({ repositories: platform_integrations.repositories })
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.GITHUB),
            eq(platform_integrations.platform_installation_id, input.installationId),
            effectiveAppTypeCondition(input.appType),
            isNull(platform_integrations.github_disconnected_at)
          )
        )
        .for('update');
      for (const integration of legacy) {
        const removed = new Set(input.repositoryIdsRemoved ?? []);
        const current = parsePlatformRepositoryCache(integration.repositories).filter(
          repository => !removed.has(repository.id)
        );
        const additions = (input.repositoriesAdded ?? []).filter(
          repository => !removed.has(repository.id)
        );
        const repositories = [
          ...current.filter(
            repository => !additions.some(addition => addition.id === repository.id)
          ),
          ...additions,
        ];
        await tx
          .update(platform_integrations)
          .set({ repositories, repositories_synced_at: now, updated_at: now })
          .where(
            and(
              eq(platform_integrations.platform, PLATFORM.GITHUB),
              eq(platform_integrations.platform_installation_id, input.installationId),
              effectiveAppTypeCondition(input.appType),
              isNull(platform_integrations.github_installation_id),
              isNull(platform_integrations.github_disconnected_at)
            )
          );
      }
      return;
    }
    const removed = new Set(input.repositoryIdsRemoved ?? []);
    const existing = parsePlatformRepositoryCache(canonical.repositories).filter(
      repo => !removed.has(repo.id)
    );
    const additions = (input.repositoriesAdded ?? []).filter(repo => !removed.has(repo.id));
    const repositories = [
      ...existing.filter(repo => !additions.some(addition => addition.id === repo.id)),
      ...additions,
    ];
    await tx
      .update(github_app_installations)
      .set({
        repositories,
        repositories_synced_at: now,
        observed_at: now,
        revision: sql`${github_app_installations.revision} + 1`,
        updated_at: now,
      })
      .where(eq(github_app_installations.id, canonical.id));
    await tx
      .update(platform_integrations)
      .set({ repositories, repositories_synced_at: now, updated_at: now })
      .where(
        and(
          eq(platform_integrations.github_installation_id, canonical.id),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          isNull(platform_integrations.github_disconnected_at)
        )
      );
    await tx
      .update(platform_integrations)
      .set({ repositories, repositories_synced_at: now, updated_at: now })
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          eq(platform_integrations.platform_installation_id, input.installationId),
          effectiveAppTypeCondition(input.appType),
          isNull(platform_integrations.github_installation_id),
          isNull(platform_integrations.github_disconnected_at)
        )
      );
  });
}

export async function updateGitHubInstallationAccountIdentity(input: {
  installationId: string;
  appType: 'standard' | 'lite';
  accountId: string;
  accountLogin: string;
}) {
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.appType}:${input.installationId}`}))`
    );
    const [canonical] = await tx
      .select({ id: github_app_installations.id })
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, input.appType),
          eq(github_app_installations.installation_id, input.installationId)
        )
      )
      .for('update');
    if (!canonical) return;
    await tx
      .update(github_app_installations)
      .set({
        account_id: input.accountId,
        account_login: input.accountLogin,
        observed_at: now,
        revision: sql`${github_app_installations.revision} + 1`,
        updated_at: now,
      })
      .where(eq(github_app_installations.id, canonical.id));
    await tx
      .update(platform_integrations)
      .set({
        platform_account_id: input.accountId,
        platform_account_login: input.accountLogin,
        updated_at: now,
      })
      .where(
        and(
          eq(platform_integrations.github_installation_id, canonical.id),
          isNull(platform_integrations.github_disconnected_at)
        )
      );
  });
}

export async function isSharedGitHubInstallation(
  installationId: string,
  appType: 'standard' | 'lite'
): Promise<boolean> {
  const associations = await db
    .select({ role: platform_integrations.github_connection_role })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        effectiveAppTypeCondition(appType),
        eq(platform_integrations.platform_installation_id, installationId)
      )
    )
    .limit(2);
  return associations.length > 1 || associations[0]?.role === 'agent_only';
}

export async function canUninstallGitHubInstallation(
  integration: typeof platform_integrations.$inferSelect
): Promise<boolean> {
  if (integration.github_connection_role !== 'workflow' || !integration.platform_installation_id)
    return false;
  const [other] = await db
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.platform_installation_id, integration.platform_installation_id),
        effectiveAppTypeCondition(integration.github_app_type ?? 'standard'),
        ne(platform_integrations.id, integration.id),
        isNull(platform_integrations.github_disconnected_at)
      )
    )
    .limit(1);
  return !other;
}

export async function materializeGitHubInstallationIdentity(input: {
  installationId: string;
  appType: 'standard' | 'lite';
}): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.appType}:${input.installationId}`}))`
    );
    await tx
      .insert(github_app_installations)
      .values({ github_app_type: input.appType, installation_id: input.installationId })
      .onConflictDoNothing({
        target: [
          github_app_installations.github_app_type,
          github_app_installations.installation_id,
        ],
      });
  });
}

export async function getGitHubInstallationDeliveryStatus(input: {
  installationId: string;
  appType: 'standard' | 'lite';
  deliveryId: string;
}): Promise<'completed' | 'processing' | 'not_completed' | 'missing_canonical'> {
  const [installation] = await db
    .select({ id: github_app_installations.id })
    .from(github_app_installations)
    .where(
      and(
        eq(github_app_installations.github_app_type, input.appType),
        eq(github_app_installations.installation_id, input.installationId)
      )
    )
    .limit(1);
  if (!installation) return 'missing_canonical';
  const [receipt] = await db
    .select({ status: github_installation_webhook_receipts.status })
    .from(github_installation_webhook_receipts)
    .where(
      and(
        eq(github_installation_webhook_receipts.github_installation_id, installation.id),
        eq(github_installation_webhook_receipts.delivery_id, input.deliveryId)
      )
    )
    .limit(1);
  if (!receipt) return 'not_completed';
  return receipt.status === 'completed' ? 'completed' : 'processing';
}

export type GitHubInstallationDeliveryClaim =
  | { status: 'claimed'; githubInstallationId: string }
  | { status: 'completed' | 'processing' | 'missing_canonical' };

// A dispatch is bounded by the webhook function timeout (well under 5 minutes), so a
// processing receipt older than this window can only belong to a killed request and
// may be safely reclaimed instead of suppressing GitHub's redelivery forever.
export const GITHUB_INSTALLATION_DELIVERY_STALE_CLAIM_MS = 10 * 60_000;

export async function claimGitHubInstallationDelivery(input: {
  installationId: string;
  appType: 'standard' | 'lite';
  deliveryId: string;
  eventType: string;
}): Promise<GitHubInstallationDeliveryClaim> {
  const [installation] = await db
    .select({ id: github_app_installations.id })
    .from(github_app_installations)
    .where(
      and(
        eq(github_app_installations.github_app_type, input.appType),
        eq(github_app_installations.installation_id, input.installationId)
      )
    )
    .limit(1);
  if (!installation) return { status: 'missing_canonical' };

  const claimed = await db
    .insert(github_installation_webhook_receipts)
    .values({
      github_installation_id: installation.id,
      delivery_id: input.deliveryId,
      event_type: input.eventType,
      status: 'processing',
    })
    .onConflictDoNothing({
      target: [
        github_installation_webhook_receipts.github_installation_id,
        github_installation_webhook_receipts.delivery_id,
      ],
    })
    .returning({ id: github_installation_webhook_receipts.id });
  if (claimed.length === 1) {
    return { status: 'claimed', githubInstallationId: installation.id };
  }

  const [receipt] = await db
    .select({ status: github_installation_webhook_receipts.status })
    .from(github_installation_webhook_receipts)
    .where(
      and(
        eq(github_installation_webhook_receipts.github_installation_id, installation.id),
        eq(github_installation_webhook_receipts.delivery_id, input.deliveryId)
      )
    )
    .limit(1);
  if (!receipt) return { status: 'processing' };
  if (receipt.status === 'completed') return { status: 'completed' };

  // created_at is the claim timestamp: it is set on insert and refreshed on reclaim.
  // The conditional update plus row lock lets exactly one concurrent redelivery win.
  const staleBefore = new Date(
    Date.now() - GITHUB_INSTALLATION_DELIVERY_STALE_CLAIM_MS
  ).toISOString();
  const reclaimed = await db
    .update(github_installation_webhook_receipts)
    .set({ created_at: new Date().toISOString() })
    .where(
      and(
        eq(github_installation_webhook_receipts.github_installation_id, installation.id),
        eq(github_installation_webhook_receipts.delivery_id, input.deliveryId),
        eq(github_installation_webhook_receipts.status, 'processing'),
        lt(github_installation_webhook_receipts.created_at, staleBefore)
      )
    )
    .returning({ id: github_installation_webhook_receipts.id });
  return reclaimed.length === 1
    ? { status: 'claimed', githubInstallationId: installation.id }
    : { status: 'processing' };
}

export async function completeGitHubInstallationDelivery(input: {
  githubInstallationId: string;
  deliveryId: string;
}): Promise<void> {
  await db
    .update(github_installation_webhook_receipts)
    .set({ status: 'completed' })
    .where(
      and(
        eq(github_installation_webhook_receipts.github_installation_id, input.githubInstallationId),
        eq(github_installation_webhook_receipts.delivery_id, input.deliveryId),
        eq(github_installation_webhook_receipts.status, 'processing')
      )
    );
}

export async function releaseGitHubInstallationDelivery(input: {
  githubInstallationId: string;
  deliveryId: string;
}): Promise<void> {
  await db
    .delete(github_installation_webhook_receipts)
    .where(
      and(
        eq(github_installation_webhook_receipts.github_installation_id, input.githubInstallationId),
        eq(github_installation_webhook_receipts.delivery_id, input.deliveryId),
        eq(github_installation_webhook_receipts.status, 'processing')
      )
    );
}

export async function recordCompletedGitHubInstallationDelivery(input: {
  installationId: string;
  appType: 'standard' | 'lite';
  deliveryId: string;
  eventType: string;
}): Promise<void> {
  const [installation] = await db
    .select({ id: github_app_installations.id })
    .from(github_app_installations)
    .where(
      and(
        eq(github_app_installations.github_app_type, input.appType),
        eq(github_app_installations.installation_id, input.installationId)
      )
    )
    .limit(1);
  if (!installation) throw new Error('Canonical GitHub installation not found for delivery');
  await db
    .insert(github_installation_webhook_receipts)
    .values({
      github_installation_id: installation.id,
      delivery_id: input.deliveryId,
      event_type: input.eventType,
      status: 'completed',
    })
    .onConflictDoNothing({
      target: [
        github_installation_webhook_receipts.github_installation_id,
        github_installation_webhook_receipts.delivery_id,
      ],
    });
}

export async function bindGitHubIntegrationToCanonicalInstallation(
  input: {
    integrationId: string;
    installationId: string;
    appType: 'standard' | 'lite';
  },
  transaction?: DbTransaction
) {
  const execute = async (tx: DbTransaction) => {
    await lockGitHubInstallationIdentity(tx, input.appType, input.installationId);
    const [canonical] = await tx
      .select({ id: github_app_installations.id })
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, input.appType),
          eq(github_app_installations.installation_id, input.installationId),
          eq(github_app_installations.lifecycle_state, 'active')
        )
      )
      .for('update');
    if (!canonical) throw new Error('Canonical GitHub installation is not active');
    const bound = await tx
      .update(platform_integrations)
      .set({
        github_installation_id: canonical.id,
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          or(
            eq(platform_integrations.github_connection_role, 'workflow'),
            eq(platform_integrations.github_connection_role, 'agent_only')
          ),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          eq(platform_integrations.platform_installation_id, input.installationId),
          effectiveAppTypeCondition(input.appType),
          isNull(platform_integrations.github_disconnected_at)
        )
      )
      .returning({ id: platform_integrations.id });
    if (bound.length !== 1) throw new Error('GitHub integration could not be bound');
  };
  return transaction ? execute(transaction) : db.transaction(execute);
}
