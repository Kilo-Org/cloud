import {
  type PlatformAccessTokenCredential,
  type PlatformIntegration,
  type PlatformOAuthCredential,
} from '@kilocode/db/schema';
import {
  GitLabOAuthCredentialRowSchema,
  GitLabPersonalAccessTokenCredentialRowSchema,
  GitLabPersonalAccessTokenMetadataSchema,
  GitLabProjectAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenMetadataSchema,
} from '@kilocode/worker-utils/gitlab-credential';
import { getGitLabIntegrationOwner } from './credential-migration-legacy';

/**
 * Compares an integration's encrypted credential rows against its parent
 * integration and the GitLab row schemas. Used as the per-row safety guard
 * before scrubbing: a non-zero mismatch count means the encrypted rows are not a
 * faithful, well-formed copy of the legacy plaintext, so the plaintext must not
 * be deleted.
 */
export function auditGitLabCredentialProfiles(
  integration: PlatformIntegration,
  providerBaseUrl: string,
  oauthCredential: PlatformOAuthCredential | undefined,
  accessCredentials: PlatformAccessTokenCredential[]
): { profileMismatches: number; providerMetadataMismatches: number } {
  const owner = getGitLabIntegrationOwner(integration);
  const authorizerMatchesOwner = (authorizedByUserId: string | null) =>
    owner.type === 'user'
      ? authorizedByUserId === owner.id
      : authorizedByUserId === null || authorizedByUserId.length > 0;
  let profileMismatches = 0;
  let providerMetadataMismatches = 0;

  if (oauthCredential) {
    const matchesParent =
      integration.integration_type === 'oauth' &&
      authorizerMatchesOwner(oauthCredential.authorized_by_user_id) &&
      oauthCredential.provider_subject_id === integration.platform_account_id &&
      oauthCredential.provider_subject_login === integration.platform_account_login &&
      oauthCredential.provider_base_url === providerBaseUrl;
    if (!matchesParent || !GitLabOAuthCredentialRowSchema.safeParse(oauthCredential).success) {
      profileMismatches += 1;
    }
  }

  for (const credential of accessCredentials) {
    if (credential.provider_credential_type === 'personal_access_token') {
      const providerMetadataResult = GitLabPersonalAccessTokenMetadataSchema.safeParse(
        credential.provider_metadata
      );
      if (!providerMetadataResult.success) providerMetadataMismatches += 1;
      const schemaInput = providerMetadataResult.success
        ? credential
        : { ...credential, provider_metadata: {} };
      const matchesParent =
        integration.integration_type === 'pat' &&
        authorizerMatchesOwner(credential.authorized_by_user_id) &&
        credential.provider_resource_id === null &&
        credential.provider_base_url === providerBaseUrl;
      if (
        !matchesParent ||
        !GitLabPersonalAccessTokenCredentialRowSchema.safeParse(schemaInput).success
      ) {
        profileMismatches += 1;
      }
      continue;
    }

    if (credential.provider_credential_type === 'project_access_token') {
      const providerMetadataResult = GitLabProjectAccessTokenMetadataSchema.safeParse(
        credential.provider_metadata
      );
      if (!providerMetadataResult.success) providerMetadataMismatches += 1;
      const schemaInput = providerMetadataResult.success
        ? credential
        : {
            ...credential,
            provider_metadata: { providerCredentialId: '1', expiresOn: '2030-01-01' },
          };
      const matchesParent =
        (integration.integration_type === 'oauth' || integration.integration_type === 'pat') &&
        credential.authorized_by_user_id === null &&
        credential.provider_base_url === providerBaseUrl;
      if (
        !matchesParent ||
        !GitLabProjectAccessTokenCredentialRowSchema.safeParse(schemaInput).success
      ) {
        profileMismatches += 1;
      }
      continue;
    }

    profileMismatches += 1;
  }

  return { profileMismatches, providerMetadataMismatches };
}
