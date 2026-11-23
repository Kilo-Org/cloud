import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { platform_access_token_credentials, type PlatformIntegration } from '@kilocode/db/schema';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  GitLabProjectAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenMetadataSchema,
} from '@kilocode/worker-utils/gitlab-credential';
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
 * True when a stored handle for the project still needs a provider call to
 * settle: an encrypted credential row, a legacy token id, or a legacy entry.
 */
export function hasStoredProjectTokenHandle(
  integration: Pick<PlatformIntegration, 'metadata'>,
  projectId: string,
  storedCredential: StoredProjectCredential | null
): boolean {
  return (
    storedCredential !== null ||
    readLegacyProjectTokenId(integration.metadata, projectId) !== null ||
    hasLegacyProjectTokenEntry(integration.metadata, projectId)
  );
}

/**
 * Drops one stored project token entry that exists and names no revocable
 * token id, which a provider call cannot settle. Returns true when it dropped
 * one, and false when the project still has a handle or has none. Needs no
 * provider credential.
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

/**
 * Refusal for a re-check that finds a stored handle appearing after the
 * settlement already reported nothing blocking, so no revocation was
 * attempted for it. A repeat of the same request settles it first.
 */
export function gitlabProjectTokensUnsettledMessage(projectIds: readonly string[]): string {
  return instanceChangeBlockerMessage('not_attempted', projectIds);
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
 * Budget for one project-token walk inside one request. The settlement walk, the
 * retirement walk, and each single-credential retirement create their own
 * deadline at this value, so each bounds only its own provider work. One connect
 * runs at most one of the two walks: settlement requires the stored account to
 * match the caller, and retirement requires it to differ.
 */
export const PROJECT_TOKEN_WALK_BUDGET_MS = 20_000;

/** What the mark statement did with one project the walk did not reach. */
type UnreachedProjectOutcome =
  /** Its row carried no marker and now does. */
  | { projectId: string; outcome: 'marked' }
  /** Its row already carried the marker, so it was left as it is. */
  | { projectId: string; outcome: 'already-unusable' }
  /** It holds only a metadata entry, so no row can carry a marker. */
  | { projectId: string; outcome: 'no-credential' }
  /** Its row belongs to the connected account, so it needs no marker. */
  | { projectId: string; outcome: 'ignored' };

/**
 * Projects one mark batch reads and writes per statement, so one bind list stays
 * far below the 65,535 parameters a Postgres statement accepts.
 */
const UNREACHED_MARK_BATCH_SIZE = 500;

/**
 * Marks the credentials the walk does not reach after the deadline in batches of
 * one read and one statement, so every project the walk lists is accounted for.
 * It reports what it did with each project, because the walk counts them as the
 * loop would have: a project it marked or never could mark keeps a handle the
 * walk did not settle, one already marked keeps a handle, and a project of the
 * connected account is left alone.
 *
 * A batch whose rows cannot be read leaves its projects unclassified, and the
 * caller must not count them as skipped. A failed marker write is reported per
 * project, because the row itself was read and classified.
 */
async function markUnreachedProjectCredentialsUnusable(input: {
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>;
  projectIds: readonly string[];
  currentAccountId: string;
}): Promise<{
  outcomes: UnreachedProjectOutcome[];
  /** Projects whose rows could not be read, so their account is unknown. */
  unreadableProjectIds: string[];
  /** Projects whose rows were read but whose marker did not store. */
  unmarkedProjectIds: string[];
  errors: unknown[];
}> {
  const outcomes: UnreachedProjectOutcome[] = [];
  const unreadableProjectIds: string[] = [];
  const unmarkedProjectIds: string[] = [];
  const errors: unknown[] = [];
  for (let start = 0; start < input.projectIds.length; start += UNREACHED_MARK_BATCH_SIZE) {
    const batch = input.projectIds.slice(start, start + UNREACHED_MARK_BATCH_SIZE);
    const rows = await readProjectCredentialRows(input.integration, batch).catch(
      (error: unknown) => {
        unreadableProjectIds.push(...batch);
        errors.push(error);
        return null;
      }
    );
    if (rows === null) continue;
    const marked = await markProjectCredentialRows({
      integration: input.integration,
      projectIds: batch,
      currentAccountId: input.currentAccountId,
      rows,
    });
    outcomes.push(...marked.outcomes);
    for (const failure of marked.failures) {
      unmarkedProjectIds.push(failure.projectId);
      errors.push(failure.error);
    }
  }
  return { errors, outcomes, unmarkedProjectIds, unreadableProjectIds };
}

/** One stored project credential read for the deadline marking. */
type UnreachedProjectCredentialRow = {
  credentialId: string;
  credentialVersion: number;
  projectId: string | null;
  providerMetadata: unknown;
};

/** Reads the stored project credentials of one batch. */
async function readProjectCredentialRows(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  projectIds: readonly string[]
): Promise<UnreachedProjectCredentialRow[]> {
  return db
    .select({
      credentialId: platform_access_token_credentials.id,
      credentialVersion: platform_access_token_credentials.credential_version,
      projectId: platform_access_token_credentials.provider_resource_id,
      providerMetadata: platform_access_token_credentials.provider_metadata,
    })
    .from(platform_access_token_credentials)
    .where(
      and(
        eq(platform_access_token_credentials.platform_integration_id, integration.id),
        eq(platform_access_token_credentials.provider_credential_type, 'project_access_token'),
        inArray(platform_access_token_credentials.provider_resource_id, [...projectIds])
      )
    );
}

/** Classifies one batch's rows and marks the ones that need it in one statement. */
async function markProjectCredentialRows(input: {
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>;
  projectIds: readonly string[];
  currentAccountId: string;
  rows: UnreachedProjectCredentialRow[];
}): Promise<{
  outcomes: UnreachedProjectOutcome[];
  failures: { projectId: string; error: unknown }[];
}> {
  const rowsByProject = new Map(input.rows.map(row => [row.projectId ?? '', row]));
  const outcomes: UnreachedProjectOutcome[] = [];
  const pending: {
    projectId: string;
    credentialId: string;
    credentialVersion: number;
    providerMetadata: Record<string, unknown>;
  }[] = [];
  const failures: { projectId: string; error: unknown }[] = [];
  for (const projectId of input.projectIds) {
    const row = rowsByProject.get(projectId);
    if (row === undefined) {
      outcomes.push({ projectId, outcome: 'no-credential' });
      continue;
    }
    const parsed = GitLabProjectAccessTokenMetadataSchema.safeParse(row.providerMetadata);
    if (!parsed.success) {
      failures.push({ projectId, error: parsed.error });
      continue;
    }
    // The walk loop settles a project of the connected account when its metadata
    // entry names an older token id, because only a revocation settles that id.
    // The deadline leaves no time for the call, so such a row takes the marker
    // and the next use replaces it, exactly as an unreached row of another
    // account does.
    if (
      parsed.data.authorizedAccountId === input.currentAccountId &&
      readLegacyProjectTokenId(input.integration.metadata, projectId) === null
    ) {
      outcomes.push({ projectId, outcome: 'ignored' });
      continue;
    }
    if (parsed.data.unusableReason !== undefined) {
      outcomes.push({ projectId, outcome: 'already-unusable' });
      continue;
    }
    pending.push({
      projectId,
      credentialId: row.credentialId,
      credentialVersion: row.credentialVersion,
      providerMetadata: { ...parsed.data, unusableReason: 'account-changed' },
    });
  }
  if (pending.length === 0) return { failures, outcomes };

  const validatedAt = new Date().toISOString();
  const updated = await db.execute<{ id: string; credential_version: number }>(sql`
    UPDATE ${platform_access_token_credentials}
    SET provider_metadata = marks.provider_metadata,
        last_validated_at = ${validatedAt},
        updated_at = now()
    FROM (VALUES ${sql.join(
      pending.map(
        entry =>
          sql`(${entry.credentialId}::uuid, ${entry.credentialVersion}::integer, ${JSON.stringify(entry.providerMetadata)}::jsonb)`
      ),
      sql`, `
    )}) AS marks(id, credential_version, provider_metadata)
    WHERE ${platform_access_token_credentials.id} = marks.id
      AND ${platform_access_token_credentials.credential_version} = marks.credential_version
    RETURNING ${platform_access_token_credentials.id} AS id,
      ${platform_access_token_credentials.credential_version} AS credential_version
  `);

  // A pending entry whose row did not come back lost a version race: its
  // credential was replaced between the read and this statement.
  const marked = new Set(updated.rows.map(row => `${row.id}:${row.credential_version}`));
  for (const entry of pending) {
    if (marked.has(`${entry.credentialId}:${entry.credentialVersion}`)) {
      outcomes.push({ projectId: entry.projectId, outcome: 'marked' });
      continue;
    }
    failures.push({ projectId: entry.projectId, error: new ProjectCredentialReplacedError() });
  }
  return { failures, outcomes };
}

/**
 * Retires every project token the integration stores for an account other than
 * the one now connected, using the credential the connect holds.
 *
 * A project keeps a handle that still belongs to the connected account, unless
 * its metadata entry names an older token id that only a revocation can settle.
 * A stored credential that already carries the unusable marker is kept as it
 * is. The walk marks a project it does not reach as unusable, together with
 * every other project it left, so the connect that replaced the account still
 * completes. A project whose stored row cannot be read counts as retained
 * without being counted in `skippedWithinRetained`, because its account is
 * unknown.
 */
export async function retireProjectCredentialsForReplacedAccount(input: {
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>;
  userToken: string;
  currentAccountId: string;
  signal?: AbortSignal;
}): Promise<{ retired: number; retained: number; skippedWithinRetained: number }> {
  const signal = input.signal ?? AbortSignal.timeout(PROJECT_TOKEN_WALK_BUDGET_MS);
  const projectIds = await listProjectIdsWithStoredTokens(input.integration);

  let retired = 0;
  let retained = 0;
  let skippedWithinRetained = 0;
  let unreachedProjectIds: string[] = [];
  for (const [index, projectId] of projectIds.entries()) {
    // Check the deadline before each row read.
    if (signal.aborted) {
      unreachedProjectIds = projectIds.slice(index);
      break;
    }

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

    if (storedCredential !== null && storedCredential.unusable) {
      retained += 1;
      continue;
    }

    const outcome = await removeStoredProjectAccessToken(input.integration, projectId, {
      userToken: input.userToken,
      signal,
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

  if (unreachedProjectIds.length > 0) {
    const marked = await markUnreachedProjectCredentialsUnusable({
      integration: input.integration,
      projectIds: unreachedProjectIds,
      currentAccountId: input.currentAccountId,
    });
    // One statement covers a batch of projects, so a failure is reported once for
    // the batch instead of once per project.
    if (marked.errors.length > 0) {
      logExceptInTest('[retireProjectCredentialsForReplacedAccount] Unusable marker not stored', {
        integrationId: input.integration.id,
        unreachedProjects: unreachedProjectIds.length,
        unreadableProjects: marked.unreadableProjectIds.length,
        unmarkedProjects: marked.unmarkedProjectIds.length,
        error:
          marked.errors[0] instanceof Error ? marked.errors[0].message : String(marked.errors[0]),
      });
    }
    // A project of the connected account needs no marker, so it is left out of
    // both counts exactly as the loop leaves it out above. Every other project
    // the walk did not settle keeps its handle, including one whose marker did
    // not store.
    const ignoredProjectIds = new Set(
      marked.outcomes
        .filter(outcome => outcome.outcome === 'ignored')
        .map(outcome => outcome.projectId)
    );
    const countedProjectIds = unreachedProjectIds.filter(
      projectId => !ignoredProjectIds.has(projectId)
    );
    // A project whose row could not be read has no known account, so it counts
    // as retained without being claimed as skipped.
    const unreadableProjectIds = new Set(marked.unreadableProjectIds);
    retained += countedProjectIds.length;
    skippedWithinRetained += countedProjectIds.filter(
      projectId => !unreadableProjectIds.has(projectId)
    ).length;
  }

  logExceptInTest('[retireProjectCredentialsForReplacedAccount] Retirement finished', {
    integrationId: input.integration.id,
    currentAccountId: input.currentAccountId,
    retired,
    retained,
    skippedWithinRetained,
  });
  return { retired, retained, skippedWithinRetained };
}
