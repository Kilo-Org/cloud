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
  ProjectCredentialReplacedError,
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

/**
 * Outcome of reading the instance a stored integration row names. An unusable
 * row is not defaulted: revoking against a host the row never named would drop
 * a handle whose token stays live on the instance it was minted on.
 */
export type StoredInstanceUrl = { ok: true; url: string } | { ok: false };

/**
 * Instance URL a stored integration row names. An absent field is gitlab.com,
 * because every writer stores the field for an instance that is not the
 * default. A field the row carries but that cannot be read as an instance URL
 * is unusable, and a caller that compares it to a requested instance treats it
 * as a change, so the stored handles are settled before the row is rewritten.
 */
export function readStoredInstanceUrl(metadata: unknown): StoredInstanceUrl {
  const parsed = GitLabInstanceUrlMetadataSchema.safeParse(metadata);
  if (!parsed.success) return { ok: false };
  if (parsed.data.gitlab_instance_url === undefined) {
    return { ok: true, url: normalizeGitLabInstanceUrl(undefined) };
  }
  try {
    return { ok: true, url: normalizeGitLabInstanceUrl(parsed.data.gitlab_instance_url) };
  } catch {
    return { ok: false };
  }
}

/**
 * True when the requested instance differs from the one a stored row names. A
 * row that carries an instance value which cannot be read counts as a change, so
 * the stored project tokens are settled before the row is rewritten instead of
 * being revoked against a defaulted host.
 */
export function storedInstanceUrlChanges(stored: StoredInstanceUrl, requestedUrl: string): boolean {
  if (!stored.ok) return true;
  try {
    return normalizeGitLabInstanceUrl(stored.url) !== normalizeGitLabInstanceUrl(requestedUrl);
  } catch {
    return true;
  }
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
 * metadata keys and stored rows whose resource id is not a project id name no
 * GitLab project, so they name no revocable token and are left out of the list.
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
    if (row.projectId === null) continue;
    if (/^[1-9][0-9]*$/.test(row.projectId)) {
      projectIds.add(row.projectId);
      continue;
    }
    logExceptInTest(
      '[listProjectIdsWithStoredTokens] Ignoring a credential row that names no project id',
      { integrationId: integration.id }
    );
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
 * Why a stored project token stays stored after a removal attempt. It names the
 * remedy: an unusable stored integration record, or a stored credential that
 * cannot be read, is repaired by Kilo support before the integration can be
 * reconnected, a refused or unresolvable credential needs a disconnect followed
 * by a reconnect with a credential that can revoke, and an unconfirmed answer or
 * a changed handle can be retried in a moment.
 */
export type ProjectTokenRetentionReason =
  | 'provider_rejected'
  | 'provider_unconfirmed'
  | 'stored_instance_unusable'
  | 'stored_credential_unreadable'
  | 'stored_handle_changed';

/**
 * How a settlement that threw is reported. Only a stored credential row that
 * cannot be read is permanent, because it fails the same way on every repeat.
 * Every other failure — a database error, a lost connection — can clear, so it
 * keeps the retryable answer instead of naming a repair.
 */
export function describeSettlementFailure(error: unknown): {
  retryable: boolean;
  reason: ProjectTokenRetentionReason;
} {
  const unreadable = error instanceof TRPCError && error.code === 'UNAUTHORIZED';
  return {
    retryable: !unreadable,
    reason: unreadable ? 'stored_credential_unreadable' : 'provider_unconfirmed',
  };
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
  | {
      outcome: 'retained';
      retryable: boolean;
      reason: ProjectTokenRetentionReason;
    };

/**
 * Kind a settlement reports for a credential it could not resolve. A definite
 * answer means the integration holds no usable credential; a broker outage or a
 * transport failure is reported as retryable.
 */
export function classifyCredentialResolutionFailure(
  error: unknown
): 'no_credential' | 'credential_unresolved' {
  if (error instanceof TRPCError && error.code !== 'SERVICE_UNAVAILABLE') return 'no_credential';
  return 'credential_unresolved';
}

/** Why one stored project token still blocks an instance change. */
export type ProjectTokenBlockerReason =
  | ProjectTokenRetentionReason
  | 'no_credential'
  | 'credential_unresolved'
  | 'not_attempted';

/** One stored project token that still blocks an instance change, and why. */
export type ProjectTokenBlocker = {
  projectId: string;
  reason: ProjectTokenBlockerReason;
};

/** What to do about one refusal, and the kind it reports. */
const BLOCKER_MESSAGES: Record<ProjectTokenBlockerReason, { cause: string; remedy: string }> = {
  stored_instance_unusable: {
    cause: 'the stored GitLab instance address could not be used',
    remedy: 'Ask Kilo support to repair the stored integration record, then reconnect.',
  },
  stored_credential_unreadable: {
    cause: 'a stored project credential could not be read',
    remedy: 'Ask Kilo support to repair the stored integration record, then reconnect.',
  },
  provider_rejected: {
    cause: 'GitLab refused the connected credential while revoking them',
    remedy:
      'Disconnect the integration, then reconnect the current instance with a credential that can revoke them.',
  },
  no_credential: {
    cause: 'no stored credential can revoke them',
    remedy:
      'Disconnect the integration, then reconnect the current instance with a credential that can revoke them.',
  },
  stored_handle_changed: {
    cause: 'a stored handle changed while they were being revoked',
    remedy: 'Try again in a moment.',
  },
  provider_unconfirmed: {
    cause: 'a revocation could not be confirmed',
    remedy: 'Try again in a moment.',
  },
  not_attempted: {
    cause: 'a revocation could not be attempted',
    remedy: 'Try again in a moment.',
  },
  credential_unresolved: {
    cause: 'the stored credential could not be reached',
    remedy: 'Try again in a moment.',
  },
};

/**
 * Order a refusal reports its causes in: a cause a request cannot clear on its
 * own comes first, a bare retry last.
 */
const BLOCKER_RANK: Record<ProjectTokenBlockerReason, number> = {
  stored_instance_unusable: 0,
  stored_credential_unreadable: 1,
  provider_rejected: 2,
  no_credential: 3,
  provider_unconfirmed: 4,
  credential_unresolved: 5,
  not_attempted: 6,
  stored_handle_changed: 7,
};

function instanceChangeBlockerMessage(
  reason: ProjectTokenBlockerReason,
  projectIds: readonly string[]
): string {
  const { cause, remedy } = BLOCKER_MESSAGES[reason];
  return `GitLab project tokens stored for the current instance could not be revoked because ${cause} (projects: ${projectIds.join(', ')}). ${remedy}`;
}

/** Refusal for an in-transaction instance change that finds a stored handle. */
export function gitlabProjectTokensUnsettledMessage(projectIds: readonly string[]): string {
  return `GitLab project tokens stored for the current instance could not be revoked (projects: ${projectIds.join(', ')}). Disconnect the integration, then reconnect the current instance with a credential that can revoke them.`;
}

/**
 * Refusal for an instance change whose stored project token list could not be
 * read, so no project id can be named.
 */
export const GITLAB_PROJECT_TOKENS_LIST_UNREADABLE_MESSAGE =
  'The stored GitLab project tokens for the current instance could not be read, so the instance change was refused. Try again in a moment.';

/**
 * Refusal that names the stored handles blocking an instance change, with the
 * remedy that applies to each cause among them. Returns null when nothing
 * blocks the change.
 */
export function describeInstanceChangeBlockers(
  blocking: readonly ProjectTokenBlocker[]
): string | null {
  if (blocking.length === 0) return null;
  const byReason = new Map<ProjectTokenBlockerReason, string[]>();
  for (const blocker of blocking) {
    const projectIds = byReason.get(blocker.reason);
    if (projectIds === undefined) byReason.set(blocker.reason, [blocker.projectId]);
    else projectIds.push(blocker.projectId);
  }
  const groups = [...byReason].sort(([a], [b]) => BLOCKER_RANK[a] - BLOCKER_RANK[b]);
  const [[firstReason, firstProjectIds], ...others] = groups;
  let message = instanceChangeBlockerMessage(firstReason, firstProjectIds);
  for (const [reason, projectIds] of others) {
    const { cause, remedy } = BLOCKER_MESSAGES[reason];
    message += ` Other project tokens are also blocked because ${cause} (projects: ${projectIds.join(', ')}). ${remedy}`;
  }
  return message;
}

/**
 * Refusal for a replacement whose replaced project token is not settled. It
 * names the cause and the step that applies to that cause: an unusable stored
 * integration record needs a repair, a refused or unresolvable credential needs
 * a disconnect and reconnect, and an unconfirmed answer or a changed handle can
 * be retried.
 */
export function describeProjectTokenReplacementBlocker(
  reason: ProjectTokenRetentionReason
): string {
  const { cause, remedy } = BLOCKER_MESSAGES[reason];
  return `The GitLab project token for this project could not be replaced because ${cause}, and it must be revoked before a replacement is created. ${remedy}`;
}

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
 * A project that has a revocable id is settled only against the instance the
 * integration row names. A row that carries an instance URL this module cannot
 * use keeps its handles without a provider call: revoking against a defaulted
 * host would drop a handle whose token stays live on the instance it was minted
 * on.
 *
 * The caller passes the credential it already holds as `options.userToken`;
 * `options.signal` carries that caller's deadline into the provider request.
 *
 * A caller that already read the credential it means to settle names it as
 * `options.expectedCredential`. The removal then acts only on that credential:
 * a stored row that is absent or differs on its id, version, or token id is
 * reported as retained without a provider call or any write, and the same
 * answer replaces the replacement error of a conditional delete.
 */
export async function removeStoredProjectAccessToken(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  projectId: string | number,
  options: {
    userToken: string;
    signal?: AbortSignal;
    expectedCredential?: StoredProjectCredential;
  }
): Promise<StoredProjectTokenRemoval> {
  const projectIdStr = requireGitLabProjectId(projectId);
  const storedCredential = await getStoredProjectCredential(integration.id, projectIdStr);
  const expectedCredential = options.expectedCredential;
  if (
    expectedCredential !== undefined &&
    (storedCredential === null ||
      storedCredential.credentialId !== expectedCredential.credentialId ||
      storedCredential.credentialVersion !== expectedCredential.credentialVersion ||
      storedCredential.tokenId !== expectedCredential.tokenId)
  ) {
    logExceptInTest(
      '[removeStoredProjectAccessToken] Stored credential is not the one named for settlement',
      {
        projectId,
        expectedTokenId: expectedCredential.tokenId,
        currentTokenId: storedCredential?.tokenId ?? null,
      }
    );
    return { outcome: 'retained', retryable: false, reason: 'stored_handle_changed' };
  }
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
  const storedInstance = readStoredInstanceUrl(integration.metadata);
  if (!storedInstance.ok) {
    logExceptInTest(
      '[removeStoredProjectAccessToken] Stored instance unusable; keeping stored project credential',
      { projectId, tokenIds }
    );
    return { outcome: 'retained', retryable: false, reason: 'stored_instance_unusable' };
  }

  try {
    for (const tokenId of tokenIds) {
      await revokeProjectAccessToken(
        options.userToken,
        projectId,
        tokenId,
        storedInstance.url,
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
      // A definitive provider answer (a 4xx other than the rate limit) repeats
      // the same refusal, so only those name a rejected credential.
      reason:
        status !== undefined && status !== 404 && status !== 429 && status < 500
          ? 'provider_rejected'
          : 'provider_unconfirmed',
    };
  }

  logExceptInTest('[removeStoredProjectAccessToken] Token revoked in GitLab', {
    projectId,
    tokenIds,
  });

  if (storedCredential) {
    try {
      await deleteStoredProjectCredential({
        integrationId: integration.id,
        projectId: projectIdStr,
        credential: storedCredential,
      });
    } catch (error) {
      if (!(expectedCredential !== undefined && error instanceof ProjectCredentialReplacedError)) {
        throw error;
      }
      logExceptInTest(
        '[removeStoredProjectAccessToken] Named credential replaced before its rows were dropped',
        { projectId, tokenId: expectedCredential.tokenId }
      );
      return { outcome: 'retained', retryable: false, reason: 'stored_handle_changed' };
    }
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
      return {
        outcome: 'retained' as const,
        retryable: false,
        reason: 'stored_handle_changed' as const,
      };
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
