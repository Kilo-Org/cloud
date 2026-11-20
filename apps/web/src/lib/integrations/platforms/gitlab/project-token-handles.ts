import 'server-only';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { platform_access_token_credentials, type PlatformIntegration } from '@kilocode/db/schema';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { GitLabProjectAccessTokenCredentialRowSchema } from '@kilocode/worker-utils/gitlab-credential';
import { revokeProjectAccessToken } from './adapter';
import { normalizeGitLabInstanceUrl } from './instance-url';
import {
  deleteStoredProjectCredential,
  deleteStoredProjectTokenMetadataEntry,
  markStoredProjectCredentialUnusable,
  readProjectCredentialAccountId,
  readProjectRevocationStatus,
  type StoredProjectCredential,
} from './project-credential-lifecycle';

/** The only field of a legacy metadata entry that can still revoke its token. */
const LegacyStoredProjectAccessTokenSchema = z
  .object({ token_id: z.number().int().positive() })
  .passthrough();

const GitLabProjectTokenMetadataSchema = z
  .object({ project_tokens: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

/**
 * Token id named by a legacy plaintext metadata entry, or null when the entry
 * is absent or does not carry a usable id.
 */
function readLegacyProjectTokenId(metadata: unknown, projectId: string): number | null {
  const parsedMetadata = GitLabProjectTokenMetadataSchema.safeParse(metadata);
  if (!parsedMetadata.success) return null;
  const entry = parsedMetadata.data.project_tokens?.[projectId];
  const parsedEntry = LegacyStoredProjectAccessTokenSchema.safeParse(entry);
  return parsedEntry.success ? parsedEntry.data.token_id : null;
}

/** True when the integration still carries any metadata entry for the project. */
function hasLegacyProjectTokenEntry(metadata: unknown, projectId: string): boolean {
  const parsedMetadata = GitLabProjectTokenMetadataSchema.safeParse(metadata);
  if (!parsedMetadata.success) return false;
  return parsedMetadata.data.project_tokens?.[projectId] !== undefined;
}

const GitLabInstanceUrlMetadataSchema = z
  .object({ gitlab_instance_url: z.string().optional() })
  .passthrough();

/** Instance URL a stored integration row names, defaulting to gitlab.com. */
function readStoredInstanceUrl(metadata: unknown): string {
  const parsed = GitLabInstanceUrlMetadataSchema.safeParse(metadata);
  return normalizeGitLabInstanceUrl(parsed.success ? parsed.data.gitlab_instance_url : undefined);
}

/** Validates a caller-supplied project id before it reaches a provider URL. */
export function requireGitLabProjectId(projectId: string | number): string {
  const value = String(projectId);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error('GitLab project ID must be a positive decimal');
  }
  return value;
}

/**
 * Encrypted project credential of one project, or null when the integration
 * stores no row for it.
 */
export async function getStoredProjectCredential(
  integrationId: string,
  projectId: string
): Promise<StoredProjectCredential | null> {
  const [row] = await db
    .select()
    .from(platform_access_token_credentials)
    .where(
      and(
        eq(platform_access_token_credentials.platform_integration_id, integrationId),
        eq(platform_access_token_credentials.provider_credential_type, 'project_access_token'),
        eq(platform_access_token_credentials.provider_resource_id, projectId)
      )
    )
    .limit(1);

  if (!row) return null;

  const parsed = GitLabProjectAccessTokenCredentialRowSchema.safeParse(row);
  const tokenId = parsed.success
    ? Number(parsed.data.provider_metadata.providerCredentialId)
    : Number.NaN;
  if (!parsed.success || !Number.isSafeInteger(tokenId)) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'GitLab project credential must be recreated',
    });
  }
  return {
    credentialId: parsed.data.id,
    credentialVersion: parsed.data.credential_version,
    tokenId,
    expiresAt: parsed.data.provider_metadata.expiresOn,
    authorizedAccountId: readProjectCredentialAccountId(parsed.data.provider_metadata),
    unusable: parsed.data.provider_metadata.unusableReason !== undefined,
  } satisfies StoredProjectCredential;
}

/**
 * Project ids whose access token belongs to the integration: the encrypted
 * rows it holds and any legacy metadata entry it still carries. Malformed
 * metadata keys are not GitLab project ids and cannot be revoked.
 */
export async function listProjectIdsWithStoredTokens(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>
): Promise<string[]> {
  const projectIds = new Set<string>();
  const parsedMetadata = GitLabProjectTokenMetadataSchema.safeParse(integration.metadata);
  const storedTokens = parsedMetadata.success ? parsedMetadata.data.project_tokens : undefined;
  if (typeof storedTokens === 'object' && storedTokens !== null) {
    for (const projectId of Object.keys(storedTokens)) {
      if (/^[1-9][0-9]*$/.test(projectId)) projectIds.add(projectId);
    }
  }

  const rows = await db
    .select({ projectId: platform_access_token_credentials.provider_resource_id })
    .from(platform_access_token_credentials)
    .where(
      and(
        eq(platform_access_token_credentials.platform_integration_id, integration.id),
        eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
      )
    );
  for (const row of rows) {
    if (row.projectId !== null) projectIds.add(row.projectId);
  }

  return [...projectIds];
}

/**
 * Drops one stored project token entry that a provider call cannot settle.
 * Returns true when it dropped one. Needs no provider credential.
 */
export async function dropUnrevokableProjectTokenEntry(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  projectId: string,
  storedCredential: StoredProjectCredential | null
): Promise<boolean> {
  if (storedCredential !== null) return false;
  if (readLegacyProjectTokenId(integration.metadata, projectId) !== null) return false;
  if (!hasLegacyProjectTokenEntry(integration.metadata, projectId)) return false;
  await deleteStoredProjectTokenMetadataEntry({ integrationId: integration.id, projectId });
  logExceptInTest('[removeStoredProjectAccessToken] Dropped entry with no revocable token id', {
    projectId,
  });
  return true;
}

/**
 * Outcome of removing one stored project token. A retained outcome says whether
 * a repeated attempt can settle it, so a caller that can try again does not
 * repeat a refusal the provider will keep answering. Only a missing answer, a
 * rate limit, or a server error can change on a repeat; a permission or
 * authentication refusal cannot. A scrubbed outcome drops an entry that named
 * no revocable token id, so nothing is left at the provider that this path
 * could reach.
 */
export type StoredProjectTokenRemoval =
  | { outcome: 'removed' }
  | { outcome: 'absent' }
  | { outcome: 'scrubbed' }
  | { outcome: 'retained'; retryable: boolean };

/** Refusal for an instance change while a stored project token is not settled. */
export const GITLAB_PROJECT_TOKENS_UNSETTLED_MESSAGE =
  'GitLab project tokens stored for the current instance must be revoked before the integration can connect to another instance. Reconnect the current instance with a token that can revoke them.';

/** Refusal for a replacement while the replaced project token is not settled. */
export const GITLAB_PROJECT_TOKEN_REPLACEMENT_UNSETTLED_MESSAGE =
  'The GitLab project token for this project must be revoked before a replacement is created. Reconnect the GitLab integration and retry.';

/**
 * Removes the stored Project Access Token for a project
 * Called when a project is removed from code reviews, and by every project on
 * disconnect
 *
 * The metadata entry and the encrypted credential row are deleted only after
 * GitLab settles the revocation, either by confirming it or by reporting the
 * token as already gone (404). Any other outcome keeps both handles so a later
 * removal can try again. A legacy metadata entry names a token id too, and it
 * keeps the same contract: every stored id for the project is revoked before
 * either handle is dropped. An entry that names no revocable id is dropped
 * instead of kept, because no stored reader uses its plaintext token.
 *
 * The caller passes the credential it already holds as `options.userToken`;
 * `options.signal` carries that caller's deadline into the provider request.
 */
export async function removeStoredProjectAccessToken(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  projectId: string | number,
  options: { userToken: string; signal?: AbortSignal }
): Promise<StoredProjectTokenRemoval> {
  const projectIdStr = requireGitLabProjectId(projectId);
  const storedCredential = await getStoredProjectCredential(integration.id, projectIdStr);
  const tokenIds = [
    ...new Set(
      [
        storedCredential?.tokenId,
        readLegacyProjectTokenId(integration.metadata, projectIdStr),
      ].filter((tokenId): tokenId is number => tokenId !== null && tokenId !== undefined)
    ),
  ];
  if (tokenIds.length === 0) {
    const dropped = await dropUnrevokableProjectTokenEntry(
      integration,
      projectIdStr,
      storedCredential
    );
    return { outcome: dropped ? 'scrubbed' : 'absent' };
  }
  const instanceUrl = readStoredInstanceUrl(integration.metadata);

  try {
    for (const tokenId of tokenIds) {
      await revokeProjectAccessToken(
        options.userToken,
        projectId,
        tokenId,
        instanceUrl,
        options.signal
      );
    }
  } catch (error) {
    const status = readProjectRevocationStatus(error);
    logExceptInTest(
      '[removeStoredProjectAccessToken] Revocation unsettled; keeping stored project credential',
      {
        projectId,
        tokenIds,
        status,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return {
      outcome: 'retained',
      retryable: status === undefined || status === 429 || status >= 500,
    };
  }

  logExceptInTest('[removeStoredProjectAccessToken] Token revoked in GitLab', {
    projectId,
    tokenIds,
  });

  if (storedCredential) {
    await deleteStoredProjectCredential({
      integrationId: integration.id,
      projectId: projectIdStr,
      credential: storedCredential,
    });
  } else {
    await deleteStoredProjectTokenMetadataEntry({
      integrationId: integration.id,
      projectId: projectIdStr,
    });
  }

  logExceptInTest('[removeStoredProjectAccessToken] Token removed from metadata', {
    projectId,
  });

  return { outcome: 'removed' };
}

/**
 * Retires every project token the integration stores for an account other than
 * the one now connected, using the credential the connect holds.
 *
 * A project keeps a handle that still belongs to the connected account, unless
 * its metadata entry names an older token id that only a revocation can settle.
 * A refusal keeps the handle and marks the credential unusable, so the connect
 * that replaced the account still succeeds.
 */
export async function retireProjectCredentialsForReplacedAccount(input: {
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>;
  userToken: string;
  currentAccountId: string;
}): Promise<{ retired: number; retained: number }> {
  const projectIds = await listProjectIdsWithStoredTokens(input.integration);

  let retired = 0;
  let retained = 0;
  for (const projectId of projectIds) {
    const storedCredential = await getStoredProjectCredential(
      input.integration.id,
      projectId
    ).catch(error => {
      logExceptInTest('[retireProjectCredentialsForReplacedAccount] Stored credential unreadable', {
        integrationId: input.integration.id,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (
      storedCredential !== null &&
      storedCredential.authorizedAccountId === input.currentAccountId &&
      readLegacyProjectTokenId(input.integration.metadata, projectId) === null
    ) {
      continue;
    }

    const outcome = await removeStoredProjectAccessToken(input.integration, projectId, {
      userToken: input.userToken,
    }).catch(error => {
      logExceptInTest(
        '[retireProjectCredentialsForReplacedAccount] Row changed during retirement',
        {
          integrationId: input.integration.id,
          projectId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return { outcome: 'retained' as const, retryable: false };
    });
    if (outcome.outcome !== 'retained') {
      retired += 1;
      continue;
    }

    retained += 1;
    if (storedCredential !== null) {
      await markStoredProjectCredentialUnusable({
        integrationId: input.integration.id,
        projectId,
        credential: storedCredential,
      }).catch(error => {
        logExceptInTest('[retireProjectCredentialsForReplacedAccount] Unusable marker not stored', {
          integrationId: input.integration.id,
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  logExceptInTest('[retireProjectCredentialsForReplacedAccount] Retirement finished', {
    integrationId: input.integration.id,
    currentAccountId: input.currentAccountId,
    retired,
    retained,
  });
  return { retired, retained };
}
