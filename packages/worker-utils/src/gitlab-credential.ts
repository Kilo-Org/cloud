import { z } from 'zod';

export const GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME = 'gitlab-oauth-credential-rsa-aes-256-gcm';
export const GITLAB_OAUTH_CREDENTIAL_ENVELOPE_VERSION = 1;
export const GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME =
  'gitlab-personal-access-token-rsa-aes-256-gcm';
export const GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_VERSION = 1;
export const GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME =
  'gitlab-project-access-token-rsa-aes-256-gcm';
export const GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_VERSION = 1;

const GitLabPositiveDecimalIdSchema = z.string().regex(/^[1-9][0-9]*$/);

export const GitLabPersonalAccessTokenMetadataSchema = z
  .object({
    providerCredentialId: GitLabPositiveDecimalIdSchema.optional(),
    expiresOn: z.iso.date().optional(),
  })
  .strict();

export type GitLabPersonalAccessTokenMetadata = z.infer<
  typeof GitLabPersonalAccessTokenMetadataSchema
>;

export const GitLabProjectAccessTokenMetadataSchema = z
  .object({
    providerCredentialId: GitLabPositiveDecimalIdSchema,
    expiresOn: z.iso.date(),
  })
  .strict();

export type GitLabProjectAccessTokenMetadata = z.infer<
  typeof GitLabProjectAccessTokenMetadataSchema
>;

const GitLabIsoTimestampSchema = z.iso.datetime({ offset: true });
const GitLabPostgresTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::?\d{2})?)$/;

function isCanonicalGitLabProviderBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const rawPath = /^https:\/\/[^/]*(\/[^?#]*)?/.exec(value)?.[1] ?? '';
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      rawPath.includes('\\') ||
      /%2f|%5c/i.test(rawPath) ||
      /\/\//.test(rawPath) ||
      /\/(?:(?:\.|%2e){1,2})(?:\/|$)/i.test(rawPath)
    ) {
      return false;
    }

    const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return value === `${parsed.origin}${basePath}`;
  } catch {
    return false;
  }
}

const GitLabProviderBaseUrlSchema = z
  .string()
  .refine(isCanonicalGitLabProviderBaseUrl, 'Invalid canonical GitLab provider base URL');

const GitLabCredentialTimestampSchema = z.string().refine(value => {
  if (GitLabIsoTimestampSchema.safeParse(value).success) return true;

  const match = GitLabPostgresTimestampPattern.exec(value);
  if (!match) return false;
  const [, date, time, postgresOffset] = match;
  const offset =
    postgresOffset.length === 3
      ? `${postgresOffset}:00`
      : postgresOffset.length === 5
        ? `${postgresOffset.slice(0, 3)}:${postgresOffset.slice(3)}`
        : postgresOffset;
  return GitLabIsoTimestampSchema.safeParse(`${date}T${time}${offset}`).success;
}, 'Invalid credential timestamp');

export const GitLabOAuthCredentialRowSchema = z
  .object({
    id: z.string().min(1),
    platform_integration_id: z.string().min(1),
    platform: z.string().nullable().optional(),
    authorized_by_user_id: z.string().min(1).nullable(),
    provider_subject_id: z.string().min(1),
    provider_subject_login: z.string().min(1),
    provider_base_url: GitLabProviderBaseUrlSchema,
    access_token_encrypted: z.string().min(1),
    access_token_expires_at: GitLabCredentialTimestampSchema.nullable(),
    refresh_token_encrypted: z.string().min(1).nullable(),
    refresh_token_expires_at: GitLabCredentialTimestampSchema.nullable(),
    oauth_client_secret_encrypted: z.string().min(1).nullable(),
    credential_version: z.number().int().positive(),
    revoked_at: GitLabCredentialTimestampSchema.nullable(),
    revocation_reason: z.string().nullable(),
    last_used_at: GitLabCredentialTimestampSchema.nullable(),
    created_at: GitLabCredentialTimestampSchema,
    updated_at: GitLabCredentialTimestampSchema,
  })
  .strict();

export type GitLabOAuthCredentialRow = z.infer<typeof GitLabOAuthCredentialRowSchema>;

const GitLabAccessTokenCredentialRowBaseSchema = z.object({
  id: z.string().min(1),
  platform_integration_id: z.string().min(1),
  owned_by_organization_id: z.string().nullable().optional(),
  platform: z.string().nullable().optional(),
  integration_type: z.string().nullable().optional(),
  token_encrypted: z.string().min(1),
  expires_at: z.null(),
  provider_base_url: GitLabProviderBaseUrlSchema,
  provider_scopes: z.array(z.string().min(1)).nullable(),
  provider_verified_at: GitLabCredentialTimestampSchema.nullable(),
  credential_version: z.number().int().positive(),
  last_validated_at: GitLabCredentialTimestampSchema.nullable(),
  last_used_at: GitLabCredentialTimestampSchema.nullable(),
  created_at: GitLabCredentialTimestampSchema,
  updated_at: GitLabCredentialTimestampSchema,
});

export const GitLabPersonalAccessTokenCredentialRowSchema =
  GitLabAccessTokenCredentialRowBaseSchema.extend({
    provider_credential_type: z.literal('personal_access_token'),
    provider_resource_id: z.null(),
    authorized_by_user_id: z.string().min(1).nullable(),
    provider_metadata: GitLabPersonalAccessTokenMetadataSchema,
  }).strict();

export type GitLabPersonalAccessTokenCredentialRow = z.infer<
  typeof GitLabPersonalAccessTokenCredentialRowSchema
>;

export const GitLabProjectAccessTokenCredentialRowSchema =
  GitLabAccessTokenCredentialRowBaseSchema.extend({
    provider_credential_type: z.literal('project_access_token'),
    provider_resource_id: GitLabPositiveDecimalIdSchema,
    authorized_by_user_id: z.null(),
    provider_metadata: GitLabProjectAccessTokenMetadataSchema,
  }).strict();

export type GitLabProjectAccessTokenCredentialRow = z.infer<
  typeof GitLabProjectAccessTokenCredentialRowSchema
>;

export type GitLabCredentialOwner = { type: 'user'; id: string } | { type: 'org'; id: string };

function normalizeGitLabCredentialOwner(owner: GitLabCredentialOwner): GitLabCredentialOwner {
  return { type: owner.type, id: owner.id };
}

export type GitLabOAuthSecretKind = 'access' | 'refresh' | 'oauth-client-secret';

export type GitLabOAuthCredentialAadInput = {
  credentialId: string;
  integrationId: string;
  providerBaseUrl: string;
  owner: GitLabCredentialOwner;
  authorizedByUserId: string | null;
  credentialVersion: number;
  kind: GitLabOAuthSecretKind;
};

export function buildGitLabOAuthCredentialAad(input: GitLabOAuthCredentialAadInput): string {
  return JSON.stringify({
    scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    version: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_VERSION,
    platform: 'gitlab',
    credentialId: input.credentialId,
    integrationId: input.integrationId,
    providerBaseUrl: input.providerBaseUrl,
    owner: normalizeGitLabCredentialOwner(input.owner),
    authorizedByUserId: input.authorizedByUserId,
    credentialVersion: input.credentialVersion,
    kind: input.kind,
  });
}

type GitLabAccessTokenCredentialAadBaseInput = {
  credentialId: string;
  integrationId: string;
  providerBaseUrl: string;
  owner: GitLabCredentialOwner;
  credentialVersion: number;
};

export type GitLabPersonalAccessTokenAadInput = GitLabAccessTokenCredentialAadBaseInput & {
  authorizedByUserId: string | null;
};

export type GitLabProjectAccessTokenAadInput = GitLabAccessTokenCredentialAadBaseInput & {
  providerResourceId: string;
};

export type GitLabAccessTokenCredentialAadInput =
  | (GitLabPersonalAccessTokenAadInput & {
      providerCredentialType: 'personal_access_token';
      providerResourceId: null;
    })
  | (GitLabProjectAccessTokenAadInput & {
      providerCredentialType: 'project_access_token';
    });

export function buildGitLabAccessTokenCredentialAad(
  input: GitLabAccessTokenCredentialAadInput
): string {
  if (input.providerCredentialType === 'project_access_token') {
    return JSON.stringify({
      scheme: GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
      version: GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_VERSION,
      platform: 'gitlab',
      credentialId: input.credentialId,
      integrationId: input.integrationId,
      providerBaseUrl: input.providerBaseUrl,
      owner: normalizeGitLabCredentialOwner(input.owner),
      providerCredentialType: input.providerCredentialType,
      providerResourceId: input.providerResourceId,
      credentialVersion: input.credentialVersion,
    });
  }

  return JSON.stringify({
    scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
    version: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_VERSION,
    platform: 'gitlab',
    credentialId: input.credentialId,
    integrationId: input.integrationId,
    providerBaseUrl: input.providerBaseUrl,
    owner: normalizeGitLabCredentialOwner(input.owner),
    providerCredentialType: input.providerCredentialType,
    providerResourceId: input.providerResourceId,
    authorizedByUserId: input.authorizedByUserId,
    credentialVersion: input.credentialVersion,
  });
}

export function buildGitLabPersonalAccessTokenAad(
  input: GitLabPersonalAccessTokenAadInput
): string {
  return buildGitLabAccessTokenCredentialAad({
    ...input,
    providerCredentialType: 'personal_access_token',
    providerResourceId: null,
  });
}

export function buildGitLabProjectAccessTokenAad(input: GitLabProjectAccessTokenAadInput): string {
  return buildGitLabAccessTokenCredentialAad({
    ...input,
    providerCredentialType: 'project_access_token',
  });
}
