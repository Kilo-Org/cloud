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

export type GitLabCredentialAuditCounts = {
  legacyTokenBearingIntegrations: number;
  oauthMissingCredentials: number;
  patMissingCredentials: number;
  projectMissingCredentials: number;
  credentialProfileMismatches: number;
  providerMetadataMismatches: number;
  crossTablePrimaryCredentialDuplicates: number;
  malformedMetadata: number;
  unmappableLegacyEntries: number;
  integrationTypeDisagreements: number;
  legacySecretFields: number;
};

export function emptyGitLabCredentialAuditCounts(): GitLabCredentialAuditCounts {
  return {
    legacyTokenBearingIntegrations: 0,
    oauthMissingCredentials: 0,
    patMissingCredentials: 0,
    projectMissingCredentials: 0,
    credentialProfileMismatches: 0,
    providerMetadataMismatches: 0,
    crossTablePrimaryCredentialDuplicates: 0,
    malformedMetadata: 0,
    unmappableLegacyEntries: 0,
    integrationTypeDisagreements: 0,
    legacySecretFields: 0,
  };
}

export function hasBlockingGitLabCredentialAuditIssues(
  counts: GitLabCredentialAuditCounts
): boolean {
  return (
    counts.oauthMissingCredentials > 0 ||
    counts.patMissingCredentials > 0 ||
    counts.projectMissingCredentials > 0 ||
    counts.credentialProfileMismatches > 0 ||
    counts.providerMetadataMismatches > 0 ||
    counts.crossTablePrimaryCredentialDuplicates > 0 ||
    counts.malformedMetadata > 0 ||
    counts.unmappableLegacyEntries > 0 ||
    counts.integrationTypeDisagreements > 0
  );
}

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
