import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type {
  IntegrationPermissions,
  Owner,
  PlatformRepository,
} from '@/lib/integrations/core/types';
import { github_app_installations, platform_integrations } from '@kilocode/db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { canOrganizationUseMultipleGitHubInstallations } from '@/lib/integrations/github/multiple-installations';

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
    if (!isCanonicalInstallationId(data.platformInstallationId)) {
      return { ok: false, reason: 'installation_unavailable' };
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${data.githubAppType}:${data.platformInstallationId}`}))`
    );
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${owner.type}:${owner.id}`}))`);

    if (owner.type === 'org' && !canOrganizationUseMultipleGitHubInstallations(owner.id)) {
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

    const [existing] = await tx
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

    if (existing) {
      const sameOwner =
        (owner.type === 'user' && existing.owned_by_user_id === owner.id) ||
        (owner.type === 'org' && existing.owned_by_organization_id === owner.id);
      if (!sameOwner) return { ok: false, reason: 'claimed_by_other_owner' };
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
          eq(platform_integrations.github_app_type, data.githubAppType),
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

  return transaction ? execute(transaction) : db.transaction(execute);
}

export async function disconnectGitHubInstallation(
  owner: Owner,
  integrationId: string
): Promise<void> {
  const disconnected = await db
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
      .select({ state: github_app_installations.lifecycle_state })
      .from(github_app_installations)
      .where(
        and(
          eq(github_app_installations.github_app_type, input.appType),
          eq(github_app_installations.installation_id, input.installationId)
        )
      )
      .for('update');
    if (existing?.state === 'deleted' && input.state !== 'deleted') return;
    await tx
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
      });
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
            eq(platform_integrations.platform_installation_id, input.installationId),
            effectiveAppTypeCondition(input.appType),
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
            eq(platform_integrations.platform_installation_id, input.installationId),
            effectiveAppTypeCondition(input.appType),
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
            effectiveAppTypeCondition(input.appType)
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
              isNull(platform_integrations.github_installation_id)
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
          eq(platform_integrations.platform, PLATFORM.GITHUB)
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
          isNull(platform_integrations.github_installation_id)
        )
      );
  });
}

export async function updateGitHubInstallationAccountIdentity(input: {
  integrationId: string;
  accountId: string;
  accountLogin: string;
}) {
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    const [integration] = await tx
      .select({ canonicalId: platform_integrations.github_installation_id })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, input.integrationId))
      .for('update');
    if (!integration) return;
    await tx
      .update(platform_integrations)
      .set({
        platform_account_id: input.accountId,
        platform_account_login: input.accountLogin,
        updated_at: now,
      })
      .where(eq(platform_integrations.id, input.integrationId));
    if (integration.canonicalId) {
      await tx
        .update(github_app_installations)
        .set({
          account_id: input.accountId,
          account_login: input.accountLogin,
          observed_at: now,
          updated_at: now,
        })
        .where(eq(github_app_installations.id, integration.canonicalId));
    }
  });
}
