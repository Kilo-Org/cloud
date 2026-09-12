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
  provider_installation_reservations,
  slack_oauth_credentials,
} from '@kilocode/db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  canOrganizationCreateSharedGitHubConnection,
  canOrganizationUseMultipleGitHubInstallations,
} from '@/lib/integrations/github/multiple-installations';
import { evaluateGitHubSharingCompatibility } from '@/lib/integrations/github/sharing-compatibility';
import { lockProviderOAuthOwnerRow } from '@/lib/integrations/provider-oauth-attempts';

export type DbTransaction = DrizzleTransaction;

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

function effectiveAppTypeCondition(appType: 'standard' | 'lite') {
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
            eq(platform_integrations.platform, PLATFORM.GITHUB)
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

    const requiresSharingAdmission =
      otherOwnerAssociations.length > 0 &&
      (!existing ||
        existing.github_disconnected_at !== null ||
        canonical.sharing_mode !== 'web_cloud_agent');
    if (requiresSharingAdmission) {
      if (owner.type !== 'org') return { ok: false, reason: 'claimed_by_other_owner' };
      if (!canOrganizationCreateSharedGitHubConnection(owner.id)) {
        return { ok: false, reason: 'shared_installation_disabled' };
      }
      if (otherOwnerAssociations.some(association => !association.github_installation_id)) {
        return { ok: false, reason: 'installation_unavailable' };
      }
      const compatibility = await evaluateGitHubSharingCompatibility(tx, canonical.id, owner);
      if (!compatibility.compatible) {
        return { ok: false, reason: 'incompatible_workflow' };
      }
      const affectedOwners: Owner[] = [owner];
      for (const association of otherOwnerAssociations) {
        if (association.owned_by_organization_id) {
          affectedOwners.push({ type: 'org', id: association.owned_by_organization_id });
        } else if (association.owned_by_user_id) {
          affectedOwners.push({ type: 'user', id: association.owned_by_user_id });
        }
      }
      for (const affectedOwner of affectedOwners) {
        const [slack] = await tx
          .select()
          .from(platform_integrations)
          .where(
            and(
              affectedOwner.type === 'org'
                ? eq(platform_integrations.owned_by_organization_id, affectedOwner.id)
                : eq(platform_integrations.owned_by_user_id, affectedOwner.id),
              eq(platform_integrations.platform, PLATFORM.SLACK),
              eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
            )
          );
        if (!slack) continue;
        if (!slack.platform_installation_id) {
          return { ok: false, reason: 'incompatible_workflow' };
        }
        const [reservation] = await tx
          .select()
          .from(provider_installation_reservations)
          .where(
            eq(
              provider_installation_reservations.provider_installation_id,
              slack.platform_installation_id
            )
          )
          .for('update');
        if (
          reservation &&
          (reservation.status !== 'active' ||
            reservation.platform_integration_id !== slack.id ||
            (affectedOwner.type === 'org'
              ? reservation.owned_by_organization_id !== affectedOwner.id ||
                reservation.owned_by_user_id !== null
              : reservation.owned_by_user_id !== affectedOwner.id ||
                reservation.owned_by_organization_id !== null))
        ) {
          return { ok: false, reason: 'incompatible_workflow' };
        }
        const [lockedSlack] = await tx
          .select({ id: platform_integrations.id })
          .from(platform_integrations)
          .where(eq(platform_integrations.id, slack.id))
          .for('update');
        if (!lockedSlack) return { ok: false, reason: 'incompatible_workflow' };
        const [credential] = await tx
          .select({ enterprise: slack_oauth_credentials.is_enterprise_install })
          .from(slack_oauth_credentials)
          .where(eq(slack_oauth_credentials.platform_integration_id, lockedSlack.id))
          .for('update');
        if (!credential || credential.enterprise) {
          return { ok: false, reason: 'incompatible_workflow' };
        }
        if (!reservation) {
          await tx.insert(provider_installation_reservations).values({
            provider: 'slack',
            provider_installation_id: slack.platform_installation_id,
            owned_by_user_id: affectedOwner.type === 'user' ? affectedOwner.id : null,
            owned_by_organization_id: affectedOwner.type === 'org' ? affectedOwner.id : null,
            platform_integration_id: slack.id,
            generation: 1,
            active_generation: 1,
            status: 'active',
            expires_at: '9999-12-31T23:59:59.999Z',
          });
        }
      }
      await tx
        .update(github_app_installations)
        .set({
          sharing_mode: 'web_cloud_agent',
          sharing_admission_checked_at: now,
          updated_at: now,
        })
        .where(eq(github_app_installations.id, canonical.id));
    }

    const values = {
      github_installation_id: canonical.id,
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
  await db.transaction(async tx => {
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
    if (integration.canonicalId) {
      const connectedAssociations = await tx
        .select({ id: platform_integrations.id })
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.github_installation_id, integration.canonicalId),
            isNull(platform_integrations.github_disconnected_at)
          )
        )
        .for('update');
      if (connectedAssociations.length === 1) {
        await tx
          .update(github_app_installations)
          .set({
            sharing_mode: 'exclusive',
            sharing_admission_checked_at: null,
            updated_at: new Date().toISOString(),
          })
          .where(eq(github_app_installations.id, integration.canonicalId));
      }
    }
  });
}

export async function uninstallExclusiveGitHubInstallation(input: {
  owner: Owner;
  integrationId: string;
  deleteUpstream: (installationId: string, appType: 'standard' | 'lite') => Promise<void>;
}): Promise<void> {
  await db.transaction(async tx => {
    const [identity] = await tx
      .select({
        installationId: platform_integrations.platform_installation_id,
        appType: platform_integrations.github_app_type,
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
    const appType = identity.appType ?? 'standard';
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${appType}:${identity.installationId}`}))`
    );
    const [locked] = await tx
      .select({
        canonicalId: platform_integrations.github_installation_id,
        sharingMode: github_app_installations.sharing_mode,
      })
      .from(platform_integrations)
      .leftJoin(
        github_app_installations,
        eq(platform_integrations.github_installation_id, github_app_installations.id)
      )
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          ownerCondition(input.owner),
          or(
            isNull(platform_integrations.github_installation_id),
            and(
              eq(github_app_installations.installation_id, identity.installationId),
              eq(github_app_installations.github_app_type, appType)
            )
          )
        )
      )
      .for('update', { of: platform_integrations });
    if (!locked || (locked.canonicalId && locked.sharingMode !== 'exclusive')) {
      throw new Error('GitHub installation must be disconnected locally');
    }
    const connectedAssociations = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          locked.canonicalId
            ? eq(platform_integrations.github_installation_id, locked.canonicalId)
            : and(
                isNull(platform_integrations.github_installation_id),
                eq(platform_integrations.platform_installation_id, identity.installationId),
                effectiveAppTypeCondition(appType)
              ),
          isNull(platform_integrations.github_disconnected_at)
        )
      )
      .for('update');
    if (
      connectedAssociations.length !== 1 ||
      connectedAssociations[0]?.id !== input.integrationId
    ) {
      throw new Error('GitHub installation must be disconnected locally');
    }

    await input.deleteUpstream(identity.installationId, appType);
    await observeGitHubInstallationLifecycle(
      { installationId: identity.installationId, appType, state: 'deleted' },
      tx
    );
    await tx.delete(platform_integrations).where(eq(platform_integrations.id, input.integrationId));
  });
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
        const current = (integration.repositories ?? []).filter(
          repository => !removed.has(Number(repository.id))
        );
        const additions = (input.repositoriesAdded ?? []).filter(
          repository => !removed.has(Number(repository.id))
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
    const existing = (canonical.repositories ?? []).filter(repo => !removed.has(Number(repo.id)));
    const additions = (input.repositoriesAdded ?? []).filter(repo => !removed.has(Number(repo.id)));
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
  const [installation] = await db
    .select({ sharingMode: github_app_installations.sharing_mode })
    .from(github_app_installations)
    .where(
      and(
        eq(github_app_installations.github_app_type, appType),
        eq(github_app_installations.installation_id, installationId)
      )
    )
    .limit(1);
  return installation?.sharingMode === 'web_cloud_agent';
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
}): Promise<'completed' | 'not_completed' | 'missing_canonical'> {
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
    .select({ id: github_installation_webhook_receipts.id })
    .from(github_installation_webhook_receipts)
    .where(
      and(
        eq(github_installation_webhook_receipts.github_installation_id, installation.id),
        eq(github_installation_webhook_receipts.delivery_id, input.deliveryId)
      )
    )
    .limit(1);
  return receipt ? 'completed' : 'not_completed';
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
    })
    .onConflictDoNothing({
      target: [
        github_installation_webhook_receipts.github_installation_id,
        github_installation_webhook_receipts.delivery_id,
      ],
    });
}

export async function bindGitHubIntegrationToCanonicalInstallation(input: {
  integrationId: string;
  installationId: string;
  appType: 'standard' | 'lite';
}) {
  await db.transaction(async tx => {
    const [canonical] = await tx
      .select({ id: github_app_installations.id })
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, input.appType),
          eq(github_app_installations.installation_id, input.installationId)
        )
      )
      .limit(1);
    if (!canonical) throw new Error('Canonical GitHub installation not found');
    const bound = await tx
      .update(platform_integrations)
      .set({ github_installation_id: canonical.id, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(platform_integrations.id, input.integrationId),
          eq(platform_integrations.platform, PLATFORM.GITHUB),
          eq(platform_integrations.platform_installation_id, input.installationId),
          effectiveAppTypeCondition(input.appType),
          isNull(platform_integrations.github_disconnected_at)
        )
      )
      .returning({ id: platform_integrations.id });
    if (bound.length !== 1) throw new Error('GitHub integration could not be bound');
  });
}
