import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner, PlatformRepository } from '@/lib/integrations/core/types';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { encryptGitLabOAuthCredentials } from './credential-encryption';
import {
  mutateGitLabMetadataInTransaction,
  readGitLabMetadataInTransaction,
} from './metadata-mutation';
import { retireProjectCredentialsForReplacedAccount } from './project-credential-lifecycle';
import { isDefaultGitLabInstanceUrl, normalizeGitLabInstanceUrl } from './instance-url';
import {
  gitLabCredentialActor,
  settleStoredProjectTokens,
} from '@/lib/integrations/gitlab-service';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export type StoreGitLabOAuthIntegrationInput = {
  owner: Owner;
  authorizedByUserId: string;
  providerBaseUrl: string;
  providerUser: { id: string; login: string };
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  scopes: string[];
  repositories: PlatformRepository[] | null;
};

export type StoreGitLabOAuthIntegrationResult = {
  integrationId: string;
  instanceChanged: boolean;
  accountChanged: boolean;
};

function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? eq(platform_integrations.owned_by_user_id, owner.id)
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}

function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

function instanceUrlChanged(existingUrl: string | undefined, newUrl: string): boolean {
  try {
    return normalizeGitLabInstanceUrl(existingUrl) !== newUrl;
  } catch {
    return true;
  }
}

function readOptionalMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = metadata[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`GitLab metadata ${key} must be a string`);
  return value;
}

const GitLabMetadataSnapshotSchema = z
  .object({ gitlab_instance_url: z.string().optional() })
  .passthrough();

/** Instance URL a stored integration row names, read before its transaction. */
function readStoredInstanceUrl(metadata: unknown): string | undefined {
  const parsed = GitLabMetadataSnapshotSchema.safeParse(metadata);
  return parsed.success ? parsed.data.gitlab_instance_url : undefined;
}

/**
 * Stores an OAuth connection, replacing the previous credential of the same
 * owner.
 *
 * Reconnecting a suspended integration of the same account on the same instance
 * settles the project access tokens a disconnect could not revoke. The
 * presented credential is the only one that can revoke them, and it is offered
 * only when the granted scopes include `api`, so a scope that cannot revoke
 * does not spend a refusal per stored handle. The settlement runs before the
 * transaction that makes the integration active, so no caller can mint or reuse
 * a project token while it runs.
 */
export async function storeGitLabOAuthIntegration(
  input: StoreGitLabOAuthIntegrationInput
): Promise<StoreGitLabOAuthIntegrationResult> {
  const [existing] = await db
    .select({
      id: platform_integrations.id,
      metadata: platform_integrations.metadata,
      platform_account_id: platform_integrations.platform_account_id,
      platform_installation_id: platform_integrations.platform_installation_id,
      integration_status: platform_integrations.integration_status,
    })
    .from(platform_integrations)
    .where(and(ownerCondition(input.owner), eq(platform_integrations.platform, PLATFORM.GITLAB)))
    .limit(1);
  const integrationId = existing?.id ?? randomUUID();
  const credentialId = randomUUID();
  const credentialVersion = 1;
  // The caller fetched `repositories` in this request, so a stored list is a
  // current snapshot. A null list means the fetch did not complete, which must
  // stay unsynced so the next repository read retries it.
  const repositoriesSyncedAt = input.repositories === null ? null : new Date().toISOString();
  const encrypted = encryptGitLabOAuthCredentials({
    credentialId,
    integrationId,
    providerBaseUrl: input.providerBaseUrl,
    owner: input.owner,
    authorizedByUserId: input.authorizedByUserId,
    credentialVersion,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    oauthClientSecret: input.oauthClientSecret,
  });

  if (existing) {
    let changedInstance = false;
    let changedAccount = false;
    let previousAccountId: string | null = null;
    const previousStoredAccountId =
      existing.platform_account_id ?? existing.platform_installation_id ?? null;
    if (
      existing.integration_status === INTEGRATION_STATUS.SUSPENDED &&
      !instanceUrlChanged(readStoredInstanceUrl(existing.metadata), input.providerBaseUrl) &&
      (previousStoredAccountId === null || previousStoredAccountId === input.providerUser.id) &&
      input.scopes.includes('api')
    ) {
      const settlement = await settleStoredProjectTokens(
        existing,
        gitLabCredentialActor(input.owner, input.authorizedByUserId),
        input.accessToken
      );
      logExceptInTest('[storeGitLabOAuthIntegration] Reconnect settled retained project tokens', {
        integrationId: existing.id,
        settledProjectTokens: settlement,
      });
    }

    await db.transaction(async tx => {
      const currentMetadata = await readGitLabMetadataInTransaction(tx, integrationId);
      const [currentIntegration] = await tx
        .select({
          platform_account_id: platform_integrations.platform_account_id,
          platform_installation_id: platform_integrations.platform_installation_id,
        })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integrationId))
        .limit(1);
      previousAccountId =
        currentIntegration?.platform_account_id ??
        currentIntegration?.platform_installation_id ??
        null;
      const currentInstanceUrl = readOptionalMetadataString(currentMetadata, 'gitlab_instance_url');
      const currentWebhookSecret = readOptionalMetadataString(currentMetadata, 'webhook_secret');
      changedInstance = instanceUrlChanged(currentInstanceUrl, input.providerBaseUrl);
      changedAccount =
        !changedInstance &&
        previousAccountId !== null &&
        previousAccountId !== input.providerUser.id;

      await mutateGitLabMetadataInTransaction(tx, integrationId, {
        set: {
          webhook_secret: changedInstance
            ? generateWebhookSecret()
            : (currentWebhookSecret ?? generateWebhookSecret()),
          auth_type: 'oauth',
          ...(isDefaultGitLabInstanceUrl(input.providerBaseUrl)
            ? {}
            : { gitlab_instance_url: input.providerBaseUrl }),
          ...(input.oauthClientId && input.oauthClientSecret
            ? { client_id: input.oauthClientId }
            : {}),
        },
        delete: [
          'access_token',
          'refresh_token',
          'token_expires_at',
          'client_secret',
          ...(isDefaultGitLabInstanceUrl(input.providerBaseUrl) ? ['gitlab_instance_url'] : []),
          ...(input.oauthClientId && input.oauthClientSecret ? [] : ['client_id']),
          ...(changedInstance ? ['configured_webhooks'] : []),
          ...(changedInstance || changedAccount ? ['project_tokens'] : []),
        ],
      });

      await tx
        .update(platform_integrations)
        .set({
          integration_type: 'oauth',
          platform_installation_id: input.providerUser.id,
          platform_account_id: input.providerUser.id,
          platform_account_login: input.providerUser.login,
          scopes: input.scopes,
          integration_status: INTEGRATION_STATUS.ACTIVE,
          repositories: input.repositories,
          repositories_synced_at: repositoriesSyncedAt,
          updated_at: new Date().toISOString(),
        })
        .where(eq(platform_integrations.id, integrationId));

      if (changedInstance) {
        await tx
          .delete(platform_access_token_credentials)
          .where(eq(platform_access_token_credentials.platform_integration_id, integrationId));
      } else {
        await tx
          .delete(platform_access_token_credentials)
          .where(
            and(
              eq(platform_access_token_credentials.platform_integration_id, integrationId),
              isNull(platform_access_token_credentials.provider_resource_id)
            )
          );
      }

      const credentialValues = {
        authorized_by_user_id: input.authorizedByUserId,
        provider_subject_id: input.providerUser.id,
        provider_subject_login: input.providerUser.login,
        provider_base_url: input.providerBaseUrl,
        access_token_encrypted: encrypted.accessTokenEncrypted,
        access_token_expires_at: input.accessTokenExpiresAt,
        refresh_token_encrypted: encrypted.refreshTokenEncrypted,
        refresh_token_expires_at: null,
        oauth_client_secret_encrypted: encrypted.oauthClientSecretEncrypted,
        revoked_at: null,
        revocation_reason: null,
        credential_version: credentialVersion,
        updated_at: new Date().toISOString(),
      };
      const [currentCredential] = await tx
        .select({ id: platform_oauth_credentials.id })
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integrationId))
        .limit(1);
      if (currentCredential) {
        await tx
          .delete(platform_oauth_credentials)
          .where(eq(platform_oauth_credentials.id, currentCredential.id));
      }
      await tx.insert(platform_oauth_credentials).values({
        id: credentialId,
        platform_integration_id: integrationId,
        ...credentialValues,
      });
    });

    if (changedAccount) {
      const retirement = await retireProjectCredentialsForReplacedAccount({
        integrationId,
        userToken: input.accessToken,
        instanceUrl: input.providerBaseUrl,
        currentAccountId: input.providerUser.id,
      });
      logExceptInTest(
        '[storeGitLabOAuthIntegration] Replaced GitLab account — retired project credentials',
        {
          integrationId,
          previousAccountId,
          currentAccountId: input.providerUser.id,
          retired: retirement.retired,
          retained: retirement.retained,
        }
      );
    }

    return { integrationId, instanceChanged: changedInstance, accountChanged: changedAccount };
  }

  const metadata: Record<string, unknown> = {
    webhook_secret: generateWebhookSecret(),
    auth_type: 'oauth',
  };
  if (!isDefaultGitLabInstanceUrl(input.providerBaseUrl)) {
    metadata.gitlab_instance_url = input.providerBaseUrl;
  }
  if (input.oauthClientId && input.oauthClientSecret) {
    metadata.client_id = input.oauthClientId;
  }

  await db.transaction(async tx => {
    await tx.insert(platform_integrations).values({
      id: integrationId,
      owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
      owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
      platform: PLATFORM.GITLAB,
      integration_type: 'oauth',
      platform_installation_id: input.providerUser.id,
      platform_account_id: input.providerUser.id,
      platform_account_login: input.providerUser.login,
      permissions: null,
      scopes: input.scopes,
      repository_access: 'all',
      integration_status: INTEGRATION_STATUS.ACTIVE,
      repositories: input.repositories,
      repositories_synced_at: repositoriesSyncedAt,
      metadata,
      installed_at: new Date().toISOString(),
    });
    await tx.insert(platform_oauth_credentials).values({
      id: credentialId,
      platform_integration_id: integrationId,
      authorized_by_user_id: input.authorizedByUserId,
      provider_subject_id: input.providerUser.id,
      provider_subject_login: input.providerUser.login,
      provider_base_url: input.providerBaseUrl,
      access_token_encrypted: encrypted.accessTokenEncrypted,
      access_token_expires_at: input.accessTokenExpiresAt,
      refresh_token_encrypted: encrypted.refreshTokenEncrypted,
      oauth_client_secret_encrypted: encrypted.oauthClientSecretEncrypted,
      credential_version: credentialVersion,
    });
  });

  return { integrationId, instanceChanged: false, accountChanged: false };
}
