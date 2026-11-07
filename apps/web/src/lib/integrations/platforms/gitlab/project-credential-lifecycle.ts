import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { platform_access_token_credentials, type PlatformIntegration } from '@kilocode/db/schema';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  GitLabAuthenticationError,
  GitLabProjectAccessTokenPermissionError,
  GitLabProjectAccessTokenRevocationError,
  revokeProjectAccessToken,
} from './adapter';
import { mutateGitLabMetadataInTransaction } from './metadata-mutation';
import {
  GitLabProjectAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenMetadataSchema,
} from '@kilocode/worker-utils/gitlab-credential';

export type StoredProjectCredential = {
  credentialId: string;
  credentialVersion: number;
  tokenId: number;
  expiresAt: string;
  authorizedAccountId: string | null;
  unusable: boolean;
};

type ProjectCredentialRef = { credentialId: string; credentialVersion: number };

export type ProjectCredentialRetirement = 'retired' | 'retained';

export function readGitLabAccountId(
  integration: Pick<PlatformIntegration, 'platform_account_id' | 'platform_installation_id'>
): string | null {
  const accountId = integration.platform_account_id ?? integration.platform_installation_id;
  return accountId !== null && accountId.trim() !== '' ? accountId : null;
}

export function readProjectCredentialAccountId(
  metadata: { authorizedAccountId?: string } | null | undefined
): string | null {
  return metadata?.authorizedAccountId ?? null;
}

export function readProjectRevocationStatus(error: unknown): number | undefined {
  if (error instanceof GitLabProjectAccessTokenRevocationError) return error.status;
  if (error instanceof GitLabProjectAccessTokenPermissionError) return error.statusCode;
  if (error instanceof GitLabAuthenticationError) return error.statusCode;
  return undefined;
}

function projectTokenMap(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const value = metadata.project_tokens;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

async function deleteProjectTokenMetadataEntry(
  tx: DrizzleTransaction,
  input: { integrationId: string; projectId: string }
): Promise<void> {
  await mutateGitLabMetadataInTransaction(tx, input.integrationId, currentMetadata => {
    const projectTokens = projectTokenMap(currentMetadata);
    delete projectTokens[input.projectId];
    return { set: { project_tokens: projectTokens } };
  });
}

export async function deleteStoredProjectCredential(input: {
  integrationId: string;
  projectId: string;
  credential: ProjectCredentialRef;
}): Promise<void> {
  await db.transaction(async tx => {
    await deleteProjectTokenMetadataEntry(tx, input);
    const deleted = await tx
      .delete(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.id, input.credential.credentialId),
          eq(
            platform_access_token_credentials.credential_version,
            input.credential.credentialVersion
          )
        )
      )
      .returning({ id: platform_access_token_credentials.id });
    if (deleted.length !== 1) {
      throw new Error('GitLab project access token was replaced concurrently');
    }
  });
}

/**
 * Removes only the legacy plaintext metadata entry of a project token.
 *
 * A leftover entry without an encrypted row is not a usable credential: the
 * token service resolves project tokens from the encrypted row only. Once the
 * provider settles the revocation of the token id that entry names, the entry
 * itself is the last handle to drop.
 */
export async function deleteStoredProjectTokenMetadataEntry(input: {
  integrationId: string;
  projectId: string;
}): Promise<void> {
  await db.transaction(tx => deleteProjectTokenMetadataEntry(tx, input));
}

export async function markStoredProjectCredentialUnusable(input: {
  integrationId: string;
  projectId: string;
  credential: ProjectCredentialRef;
}): Promise<void> {
  const validatedAt = new Date().toISOString();
  await db.transaction(async tx => {
    const [row] = await tx
      .select({
        provider_metadata: platform_access_token_credentials.provider_metadata,
        credential_version: platform_access_token_credentials.credential_version,
      })
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.id, input.credential.credentialId),
          eq(
            platform_access_token_credentials.credential_version,
            input.credential.credentialVersion
          )
        )
      )
      .limit(1);
    if (!row) {
      throw new Error('GitLab project access token was replaced concurrently');
    }
    const providerMetadata = GitLabProjectAccessTokenMetadataSchema.parse({
      ...GitLabProjectAccessTokenMetadataSchema.parse(row.provider_metadata),
      unusableReason: 'account-changed',
    });
    const updated = await tx
      .update(platform_access_token_credentials)
      .set({ provider_metadata: providerMetadata, last_validated_at: validatedAt })
      .where(
        and(
          eq(platform_access_token_credentials.id, input.credential.credentialId),
          eq(
            platform_access_token_credentials.credential_version,
            input.credential.credentialVersion
          )
        )
      )
      .returning({ id: platform_access_token_credentials.id });
    if (updated.length !== 1) {
      throw new Error('GitLab project access token was replaced concurrently');
    }
  });
}

export async function retireStoredProjectCredential(input: {
  integrationId: string;
  projectId: string;
  credential: StoredProjectCredential;
  userToken: string;
  instanceUrl: string;
}): Promise<ProjectCredentialRetirement> {
  try {
    await revokeProjectAccessToken(
      input.userToken,
      input.projectId,
      input.credential.tokenId,
      input.instanceUrl
    );
  } catch (error) {
    logExceptInTest('[retireStoredProjectCredential] Retirement refused; marking unusable', {
      integrationId: input.integrationId,
      projectId: input.projectId,
      tokenId: input.credential.tokenId,
      status: readProjectRevocationStatus(error),
      error: error instanceof Error ? error.message : String(error),
    });
    await markStoredProjectCredentialUnusable({
      integrationId: input.integrationId,
      projectId: input.projectId,
      credential: input.credential,
    });
    return 'retained';
  }

  logExceptInTest('[retireStoredProjectCredential] Retired credential of the replaced account', {
    integrationId: input.integrationId,
    projectId: input.projectId,
    tokenId: input.credential.tokenId,
  });
  await deleteStoredProjectCredential({
    integrationId: input.integrationId,
    projectId: input.projectId,
    credential: input.credential,
  });
  return 'retired';
}

export async function retireProjectCredentialsForReplacedAccount(input: {
  integrationId: string;
  userToken: string;
  instanceUrl: string;
  currentAccountId: string;
}): Promise<{ retired: number; retained: number }> {
  const rows = await db
    .select()
    .from(platform_access_token_credentials)
    .where(
      and(
        eq(platform_access_token_credentials.platform_integration_id, input.integrationId),
        eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
      )
    );

  let retired = 0;
  let retained = 0;
  for (const row of rows) {
    const parsed = GitLabProjectAccessTokenCredentialRowSchema.safeParse(row);
    if (!parsed.success) continue;
    if (parsed.data.provider_metadata.authorizedAccountId === input.currentAccountId) continue;
    const tokenId = Number(parsed.data.provider_metadata.providerCredentialId);
    if (!Number.isSafeInteger(tokenId)) continue;

    const outcome = await retireStoredProjectCredential({
      integrationId: input.integrationId,
      projectId: parsed.data.provider_resource_id,
      credential: {
        credentialId: parsed.data.id,
        credentialVersion: parsed.data.credential_version,
        tokenId,
        expiresAt: parsed.data.provider_metadata.expiresOn,
        authorizedAccountId: readProjectCredentialAccountId(parsed.data.provider_metadata),
        unusable: parsed.data.provider_metadata.unusableReason !== undefined,
      },
      userToken: input.userToken,
      instanceUrl: input.instanceUrl,
    }).catch(error => {
      logExceptInTest(
        '[retireProjectCredentialsForReplacedAccount] Row changed during retirement',
        {
          integrationId: input.integrationId,
          projectId: parsed.data.provider_resource_id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return 'retained' as const;
    });
    if (outcome === 'retired') retired += 1;
    else retained += 1;
  }

  logExceptInTest('[retireProjectCredentialsForReplacedAccount] Retirement finished', {
    integrationId: input.integrationId,
    currentAccountId: input.currentAccountId,
    retired,
    retained,
  });
  return { retired, retained };
}
