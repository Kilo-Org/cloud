import { randomUUID } from 'node:crypto';
import type { DrizzleTransaction } from '@/lib/drizzle';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  GitLabPersonalAccessTokenMetadataSchema,
  GitLabProjectAccessTokenMetadataSchema,
} from '@kilocode/worker-utils/gitlab-credential';
import {
  encryptGitLabOAuthCredentials,
  encryptGitLabPersonalAccessToken,
  encryptGitLabProjectAccessToken,
} from './credential-encryption';
import {
  getGitLabIntegrationOwner,
  type GitLabLegacyMetadata,
} from './credential-migration-legacy';
import { normalizeGitLabInstanceUrl } from './instance-url';

type ExistingCredentialRows = {
  oauth: typeof platform_oauth_credentials.$inferSelect | undefined;
  primaryAccess: typeof platform_access_token_credentials.$inferSelect | undefined;
  access: (typeof platform_access_token_credentials.$inferSelect)[];
};

export type GitLabBackfillResult = {
  mutated: boolean;
  unmappableProjects: number;
};

export async function backfillMissingGitLabCredentials(
  tx: DrizzleTransaction,
  integration: PlatformIntegration,
  metadata: GitLabLegacyMetadata,
  existing: ExistingCredentialRows
): Promise<GitLabBackfillResult> {
  const owner = getGitLabIntegrationOwner(integration);
  const providerBaseUrl = normalizeGitLabInstanceUrl(metadata.gitlab_instance_url);
  let mutated = false;
  let primaryInserted = false;

  if (
    metadata.auth_type === 'oauth' &&
    metadata.access_token &&
    metadata.refresh_token &&
    integration.platform_account_id &&
    integration.platform_account_login &&
    (metadata.client_id === undefined) === (metadata.client_secret === undefined) &&
    !existing.oauth &&
    !existing.primaryAccess
  ) {
    const credentialId = randomUUID();
    const credentialVersion = 1;
    const authorizedByUserId = owner.type === 'user' ? owner.id : null;
    const encrypted = encryptGitLabOAuthCredentials({
      credentialId,
      integrationId: integration.id,
      providerBaseUrl,
      owner,
      authorizedByUserId,
      credentialVersion,
      accessToken: metadata.access_token,
      refreshToken: metadata.refresh_token,
      oauthClientSecret: metadata.client_secret ?? null,
    });
    const inserted = await tx
      .insert(platform_oauth_credentials)
      .values({
        id: credentialId,
        platform_integration_id: integration.id,
        authorized_by_user_id: authorizedByUserId,
        provider_subject_id: integration.platform_account_id,
        provider_subject_login: integration.platform_account_login,
        provider_base_url: providerBaseUrl,
        access_token_encrypted: encrypted.accessTokenEncrypted,
        access_token_expires_at: metadata.token_expires_at ?? null,
        refresh_token_encrypted: encrypted.refreshTokenEncrypted,
        oauth_client_secret_encrypted: encrypted.oauthClientSecretEncrypted,
        credential_version: credentialVersion,
      })
      .onConflictDoNothing()
      .returning({ id: platform_oauth_credentials.id });
    primaryInserted = inserted.length === 1;
    mutated ||= primaryInserted;
  } else if (
    metadata.auth_type === 'pat' &&
    metadata.access_token &&
    !existing.primaryAccess &&
    !existing.oauth
  ) {
    const credentialId = randomUUID();
    const credentialVersion = 1;
    const authorizedByUserId = owner.type === 'user' ? owner.id : null;
    const tokenEncrypted = encryptGitLabPersonalAccessToken({
      token: metadata.access_token,
      credentialId,
      integrationId: integration.id,
      providerBaseUrl,
      owner,
      authorizedByUserId,
      credentialVersion,
    });
    const inserted = await tx
      .insert(platform_access_token_credentials)
      .values({
        id: credentialId,
        platform_integration_id: integration.id,
        token_encrypted: tokenEncrypted,
        provider_credential_type: 'personal_access_token',
        provider_resource_id: null,
        provider_base_url: providerBaseUrl,
        authorized_by_user_id: authorizedByUserId,
        provider_metadata: GitLabPersonalAccessTokenMetadataSchema.parse({}),
        provider_scopes: integration.scopes ?? null,
        credential_version: credentialVersion,
      })
      .onConflictDoNothing()
      .returning({ id: platform_access_token_credentials.id });
    primaryInserted = inserted.length === 1;
    mutated ||= primaryInserted;
  }

  if (primaryInserted && metadata.auth_type !== integration.integration_type) {
    await tx
      .update(platform_integrations)
      .set({ integration_type: metadata.auth_type, updated_at: new Date().toISOString() })
      .where(eq(platform_integrations.id, integration.id));
  }

  const integrationType = primaryInserted
    ? metadata.auth_type
    : integration.integration_type === 'oauth' || integration.integration_type === 'pat'
      ? integration.integration_type
      : null;
  let unmappableProjects = 0;
  const existingProjectIds = new Set(
    existing.access.flatMap(row =>
      row.provider_credential_type === 'project_access_token' && row.provider_resource_id
        ? [row.provider_resource_id]
        : []
    )
  );
  for (const [projectId, projectToken] of Object.entries(metadata.project_tokens ?? {})) {
    if (existingProjectIds.has(projectId)) continue;
    if (!integrationType || !/^[1-9][0-9]*$/.test(projectId)) {
      unmappableProjects += 1;
      continue;
    }
    const credentialId = randomUUID();
    const credentialVersion = 1;
    const tokenEncrypted = encryptGitLabProjectAccessToken({
      token: projectToken.token,
      credentialId,
      integrationId: integration.id,
      providerBaseUrl,
      owner,
      providerResourceId: projectId,
      credentialVersion,
    });
    const inserted = await tx
      .insert(platform_access_token_credentials)
      .values({
        id: credentialId,
        platform_integration_id: integration.id,
        token_encrypted: tokenEncrypted,
        provider_credential_type: 'project_access_token',
        provider_resource_id: projectId,
        provider_base_url: providerBaseUrl,
        authorized_by_user_id: null,
        provider_metadata: GitLabProjectAccessTokenMetadataSchema.parse({
          providerCredentialId: String(projectToken.token_id),
          expiresOn: projectToken.expires_at,
        }),
        provider_scopes: null,
        credential_version: credentialVersion,
      })
      .onConflictDoNothing()
      .returning({ id: platform_access_token_credentials.id });
    mutated ||= inserted.length === 1;
  }

  return { mutated, unmappableProjects };
}
