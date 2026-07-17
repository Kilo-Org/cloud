import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner, PlatformRepository } from '@/lib/integrations/core/types';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { encryptGitLabOAuthCredentials } from './credential-encryption';
import { mutateGitLabMetadataInTransaction } from './metadata-mutation';
import { isDefaultGitLabInstanceUrl, normalizeGitLabInstanceUrl } from './instance-url';

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

export async function storeGitLabOAuthIntegration(
  input: StoreGitLabOAuthIntegrationInput
): Promise<StoreGitLabOAuthIntegrationResult> {
  const [existing] = await db
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(and(ownerCondition(input.owner), eq(platform_integrations.platform, PLATFORM.GITLAB)))
    .limit(1);
  const integrationId = existing?.id ?? randomUUID();
  const credentialId = randomUUID();
  const credentialVersion = 1;
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
    await db.transaction(async tx => {
      await mutateGitLabMetadataInTransaction(tx, integrationId, currentMetadata => {
        const currentInstanceUrl = readOptionalMetadataString(
          currentMetadata,
          'gitlab_instance_url'
        );
        const currentWebhookSecret = readOptionalMetadataString(currentMetadata, 'webhook_secret');
        changedInstance = instanceUrlChanged(currentInstanceUrl, input.providerBaseUrl);

        return {
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
            ...(changedInstance ? ['configured_webhooks', 'project_tokens'] : []),
          ],
        };
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

    return { integrationId, instanceChanged: changedInstance };
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

  return { integrationId, instanceChanged: false };
}
