import 'server-only';
import { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  GITLAB_PROJECT_NOT_IN_CACHE_MESSAGE,
  matchCachedGitLabProject,
} from '@/lib/integrations/platforms/gitlab/project-scope';
import {
  requireNumericPlatformRepositories,
  shouldSyncProviderRepositories,
  type Owner,
} from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { updateRepositoriesForIntegration } from '@/lib/integrations/db/platform-integrations';
import { ownerCondition } from '@/lib/integrations/db/predicates';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import {
  fetchGitLabProjects,
  fetchGitLabBranches,
  createProjectAccessToken,
  findKiloProjectAccessToken,
  rotateProjectAccessToken,
  revokeProjectAccessToken,
  calculateProjectAccessTokenExpiry,
  isProjectAccessTokenExpiringSoon,
  validateProjectAccessToken,
  validatePersonalAccessToken,
  type GitLabProjectAccessToken,
  type GitLabProjectAccessTokenValidation,
  type GitLabPATValidationResult,
  GitLabAuthenticationError,
  GitLabProjectAccessTokenPermissionError,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { randomBytes, randomUUID } from 'crypto';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  DEFAULT_GITLAB_INSTANCE_URL,
  GitLabInstanceUrlError,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import { GITLAB_RECONNECT_REQUIRED_MESSAGE } from '@/lib/integrations/platforms/gitlab/credential-errors';
import {
  mutateGitLabMetadata,
  mutateGitLabMetadataInTransaction,
  readGitLabMetadataInTransaction,
} from '@/lib/integrations/platforms/gitlab/metadata-mutation';
import {
  encryptGitLabPersonalAccessToken,
  encryptGitLabProjectAccessToken,
} from '@/lib/integrations/platforms/gitlab/credential-encryption';
import {
  deleteStoredProjectCredential,
  deleteStoredProjectTokenMetadataEntry,
  readGitLabAccountId,
  readProjectRevocationStatus,
  retireProjectCredentialsForReplacedAccount,
  retireStoredProjectCredential,
  type StoredProjectCredential,
} from '@/lib/integrations/platforms/gitlab/project-credential-lifecycle';
import {
  GitLabPersonalAccessTokenMetadataSchema,
  GitLabProjectAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenMetadataSchema,
} from '@kilocode/worker-utils/gitlab-credential';
import {
  fetchGitLabCredential,
  type GitLabCredentialActor,
  type GitLabCredentialBrokerResult,
} from '@/lib/integrations/platforms/gitlab/credential-broker-client';

/**
 * GitLab Integration Service
 *
 * Provides business logic for GitLab OAuth integrations.
 * Handles token refresh, repository listing, and integration management.
 */

/**
 * Normalizes a GitLab instance URL for comparison.
 * Strips trailing slashes, lowercases, and treats undefined/empty as gitlab.com.
 */
export function normalizeInstanceUrl(url?: string): string {
  return normalizeGitLabInstanceUrl(url || DEFAULT_GITLAB_INSTANCE_URL);
}

/**
 * Returns true if the GitLab instance URL has changed between
 * the existing integration and the new connection.
 */
export function instanceUrlChanged(existingUrl: string | undefined, newUrl: string): boolean {
  const normalizedNewUrl = normalizeInstanceUrl(newUrl);
  try {
    return normalizeInstanceUrl(existingUrl) !== normalizedNewUrl;
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

function requireMetadataRecord(metadata: unknown): Readonly<Record<string, unknown>> {
  if (metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid GitLab integration metadata' });
  }
  return { ...metadata };
}

function countMetadataObjectEntries(value: unknown): number {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

function getGitLabIntegrationOwner(integration: PlatformIntegration): Owner {
  if (integration.owned_by_user_id && !integration.owned_by_organization_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  if (integration.owned_by_organization_id && !integration.owned_by_user_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  throw new Error('GitLab integration must have exactly one owner');
}

function requireGitLabProjectId(projectId: string | number): string {
  const value = String(projectId);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error('GitLab project ID must be a positive decimal');
  }
  return value;
}

/**
 * Get GitLab integration for an owner
 */
export async function getGitLabIntegration(owner: Owner): Promise<PlatformIntegration | null> {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.GITLAB)))
    .limit(1);

  return integration || null;
}

/**
 * Deadline for the status read's broker round trip. Shorter than the broker
 * client's own 30s request timeout: status renders spinners in the mobile
 * connect gate, so a hung token service must fail open quickly.
 */
const GITLAB_CREDENTIAL_STATUS_TIMEOUT_MS = 3_000;

/**
 * Whether the integration's stored credential is currently usable. Asks the
 * private-key holding token service to resolve it — the same resolution every
 * review read performs — so a row that is active but whose credential the
 * broker refuses answers `connected: false` instead of faking health.
 *
 * Only a definitive broker refusal disconnects. `temporarily_unavailable`
 * (and any transport error, already mapped inside the broker client) fails
 * open, so a token-service blip never renders a working connection as
 * broken.
 *
 * Status is a hot read (the mobile connect gate spins on it), so the broker
 * request races a short per-call deadline instead of the broker client's 30s
 * request timeout: a hung token service answers `connected: true` after the
 * deadline rather than stalling the settings surface. The race loser is only
 * a discarded response — the broker client's own AbortController still cleans
 * up.
 */
export async function isGitLabCredentialConnected(
  integration: PlatformIntegration,
  actor: GitLabCredentialActor
): Promise<boolean> {
  const { promise: deadline, resolve: hitDeadline } =
    Promise.withResolvers<GitLabCredentialBrokerResult>();
  const timer = setTimeout(
    () => hitDeadline({ status: 'temporarily_unavailable' }),
    GITLAB_CREDENTIAL_STATUS_TIMEOUT_MS
  );
  timer.unref?.();
  try {
    const result = await Promise.race([
      fetchGitLabCredential(actor, {
        credential: 'integration',
        integrationId: integration.id,
      }),
      deadline,
    ]);
    if (result.status === 'available') return true;
    if (result.status === 'reconnect_required' || result.status === 'not_connected') return false;
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a GitLab credential through the private-key holding token service.
 */
function requireAvailableGitLabCredential(
  result: GitLabCredentialBrokerResult,
  expectedInstanceUrl: string
): string {
  if (result.status === 'available') {
    if (result.instanceUrl !== expectedInstanceUrl) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab integration changed while resolving credentials',
      });
    }
    return result.token;
  }

  switch (result.status) {
    case 'invalid_request':
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid GitLab credential request' });
    case 'not_connected':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'GitLab integration not found' });
    case 'reconnect_required':
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: GITLAB_RECONNECT_REQUIRED_MESSAGE,
      });
    case 'temporarily_unavailable':
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'GitLab credentials are temporarily unavailable',
      });
  }
}

export async function getValidGitLabToken(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  actor: GitLabCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'gitlab_instance_url')
  );
  return requireAvailableGitLabCredential(
    await fetchGitLabCredential(actor, {
      credential: 'integration',
      integrationId: integration.id,
    }),
    expectedInstanceUrl
  );
}

export async function getValidGitLabProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GitLabCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'gitlab_instance_url')
  );
  return requireAvailableGitLabCredential(
    await fetchGitLabCredential(actor, {
      credential: 'project-exact',
      integrationId: integration.id,
      projectId: requireGitLabProjectId(projectId),
    }),
    expectedInstanceUrl
  );
}

/**
 * List repositories accessible by a GitLab integration
 * Returns the cached snapshot by default, including an empty one that has
 * already synced; reads the provider when the row has no snapshot yet or when
 * forceRefresh is true
 */
export async function listGitLabRepositories(
  owner: Owner,
  integrationId: string,
  actor: GitLabCredentialActor,
  forceRefresh: boolean = false
) {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
  // Answer from the cached snapshot unless the caller forces a sync or the
  // integration has never synced: a synced empty snapshot is the
  // connected-empty state, not a reason to re-query GitLab on every read.
  if (
    shouldSyncProviderRepositories({
      forceRefresh,
      cachedRepositories,
      repositoriesSyncedAt: integration.repositories_synced_at,
    })
  ) {
    const accessToken = await getValidGitLabToken(integration, actor);
    const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
    const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);

    const repos = await fetchGitLabProjects(accessToken, instanceUrl);
    await updateRepositoriesForIntegration(integrationId, repos);

    return {
      repositories: repos,
      syncedAt: new Date().toISOString(),
    };
  }

  return {
    repositories: cachedRepositories ?? [],
    syncedAt: integration.repositories_synced_at,
  };
}

/**
 * List branches for a GitLab project
 * Always fetches fresh from GitLab (no caching)
 */
export async function listGitLabBranches(
  owner: Owner,
  integrationId: string,
  actor: GitLabCredentialActor,
  projectPath: string // must be a cached full path, e.g. "group/project"
) {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  // The connection's cached repository set is the project authorization
  // scope: a caller-supplied path must be one of its full paths, compared
  // case-insensitively end-to-end (the same rule authorizeProject enforces
  // for the review layer). The refusal comes before any token is minted, and
  // the fetch uses the cache's canonical full path in stored casing.
  const match = matchCachedGitLabProject(integration, projectPath);
  if (!match) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: GITLAB_PROJECT_NOT_IN_CACHE_MESSAGE,
    });
  }

  const accessToken = await getValidGitLabToken(integration, actor);
  const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);

  const branches = await fetchGitLabBranches(accessToken, match.full_name, instanceUrl);

  return {
    branches: branches.map(b => ({
      name: b.name,
      isDefault: b.default,
    })),
  };
}

/**
 * The actor a credential lookup uses for an owner's integration. An
 * organization integration resolves only for a member of that organization,
 * so the acting user must travel with the owner.
 */
export function gitLabCredentialActor(owner: Owner, actingUserId: string): GitLabCredentialActor {
  return {
    userId: actingUserId,
    ...(owner.type === 'org' ? { organizationId: owner.id } : {}),
  };
}

/**
 * Project ids whose access token belongs to the integration: the encrypted
 * rows it holds and any legacy metadata entry it still carries. Malformed
 * metadata keys are not GitLab project ids and cannot be revoked.
 */
async function listIntegrationProjectIds(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>
): Promise<string[]> {
  const projectIds = new Set<string>();
  const metadata = requireMetadataRecord(integration.metadata);
  const storedTokens = metadata.project_tokens;
  if (typeof storedTokens === 'object' && storedTokens !== null && !Array.isArray(storedTokens)) {
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
 * Attempts the settlement makes to revoke a project token the provider did not
 * settle. Every attempt needs the credential the caller holds, which the
 * suspension drops, so the attempts share one request.
 */
const PROJECT_TOKEN_SETTLEMENT_ATTEMPTS = 2;

/** Pause between settlement attempts, so a transient provider error can clear. */
const PROJECT_TOKEN_SETTLEMENT_RETRY_DELAY_MS = 250;

/**
 * Wall-clock budget for settling one integration's project tokens inside one
 * request. A settlement that reaches it stops attempting further projects and
 * skips its second attempt: the handles it did not reach stay stored, and a
 * reconnect of the same account settles them.
 */
const PROJECT_TOKEN_SETTLEMENT_BUDGET_MS = 20_000;

function waitForSettlementRetry(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, PROJECT_TOKEN_SETTLEMENT_RETRY_DELAY_MS);
  return promise;
}

type ProjectTokenSettlement = {
  /** Tokens the provider confirmed revoked, whose stored handles are gone. */
  revoked: number;
  /** Entries dropped because they named no revocable token id. */
  scrubbed: number;
  /** Stored handles that remain, including the ones not attempted. */
  retained: number;
  /** Handles that were listed but never attempted, for lack of credential or budget. */
  unattempted: number;
};

/**
 * Settles every project access token the integration stores, with a credential
 * the caller already holds.
 *
 * Every stored id of a project is revoked before either handle for that project
 * is dropped, so a project is retained whole or settled whole. A metadata entry
 * that names no revocable token id is dropped instead, because it is the last
 * stored copy of a secret that no revocation handle can reach. Only an answer a
 * repeat can change is attempted again: no answer, a rate limit, or a server
 * error. A permission or authentication refusal keeps its handle and is not
 * repeated.
 *
 * The work is bounded twice: by the attempt count, and by `options.signal`,
 * which defaults to a wall-clock budget. When the signal aborts, the remaining
 * projects are left as they are, so the request answers instead of being cut
 * off with live handles unattempted.
 *
 * Returns null when the stored project list cannot be read, which a caller
 * reports separately from a token the provider refused.
 */
export async function settleStoredProjectTokens(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  actor: GitLabCredentialActor,
  userToken: string | undefined,
  options: { signal?: AbortSignal } = {}
): Promise<ProjectTokenSettlement | null> {
  let projectIds: string[];
  try {
    projectIds = await listIntegrationProjectIds(integration);
  } catch (error) {
    logExceptInTest('[settleStoredProjectTokens] Project token list unavailable', {
      integrationId: integration.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (userToken === undefined) {
    // The cleanup that needs no provider call runs before the credential check,
    // so one request settles those entries too.
    const noCredentialOutstanding = new Set(projectIds);
    let noCredentialScrubbed = 0;
    for (const projectId of projectIds) {
      const dropped = await getStoredProjectCredential(integration.id, projectId)
        .then(storedCredential =>
          dropUnrevokableProjectTokenEntry(integration, projectId, storedCredential)
        )
        .catch(() => false);
      if (dropped) {
        noCredentialOutstanding.delete(projectId);
        noCredentialScrubbed += 1;
      }
    }
    return {
      revoked: 0,
      scrubbed: noCredentialScrubbed,
      retained: noCredentialOutstanding.size,
      unattempted: noCredentialOutstanding.size,
    };
  }

  const signal = options.signal ?? AbortSignal.timeout(PROJECT_TOKEN_SETTLEMENT_BUDGET_MS);
  const outstandingProjectIds = new Set(projectIds);
  const attemptedProjectIds = new Set<string>();
  const retryProjectIds = new Set<string>();
  let revoked = 0;
  let scrubbed = 0;
  for (let attempt = 0; attempt < PROJECT_TOKEN_SETTLEMENT_ATTEMPTS; attempt++) {
    if (attempt > 0 && retryProjectIds.size === 0) break;
    if (attempt > 0) {
      if (signal.aborted) break;
      await waitForSettlementRetry();
    }
    const attemptProjectIds = attempt === 0 ? [...outstandingProjectIds] : [...retryProjectIds];
    retryProjectIds.clear();
    for (const projectId of attemptProjectIds) {
      if (signal.aborted) break;
      attemptedProjectIds.add(projectId);
      const outcome = await removeStoredProjectAccessToken(integration, projectId, actor, {
        userToken,
        signal,
      }).catch(error => {
        logExceptInTest('[settleStoredProjectTokens] Project token settlement failed', {
          integrationId: integration.id,
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { outcome: 'retained' as const, retryable: false };
      });
      if (outcome.outcome === 'removed') {
        outstandingProjectIds.delete(projectId);
        revoked += 1;
      } else if (outcome.outcome === 'scrubbed') {
        outstandingProjectIds.delete(projectId);
        scrubbed += 1;
      } else if (outcome.outcome === 'retained' && outcome.retryable) {
        retryProjectIds.add(projectId);
      }
    }
  }

  const unattempted = [...outstandingProjectIds].filter(
    projectId => !attemptedProjectIds.has(projectId)
  ).length;
  return { revoked, scrubbed, retained: outstandingProjectIds.size, unattempted };
}

/**
 * Disconnect GitLab integration for an owner
 *
 * Instead of deleting the integration record, we mark it as disconnected and
 * settle the provider-side credentials it delegated:
 *
 * 1. resolve the connected credential once, while the integration still counts
 *    as connected — the token service refuses a suspended integration, so this
 *    is the last moment the credential that can revoke project tokens is
 *    reachable;
 * 2. mark the integration suspended and drop the connection's own encrypted
 *    credentials, which stops every caller and the token service from resolving
 *    anything against this integration;
 * 3. revoke each per-project access token at GitLab through the same removal
 *    contract the review lifecycle uses: a metadata entry and an encrypted row
 *    are deleted only after GitLab settles the revocation, and any other
 *    outcome keeps both.
 *
 * The settlement runs inside this request, over a bounded number of attempts
 * and a wall-clock budget, because step 2 drops the credential that can revoke
 * a token: a suspended integration resolves nothing, so a repeated disconnect
 * answers as not found. Reaching the budget stops the settlement and keeps the
 * handles it did not reach; each such handle keeps neither reading nor revoking
 * anything through this integration. Both stay revocable: a reconnect of the
 * same account, through a personal access token or OAuth, settles them with the
 * credential it presents, so a disconnect that could not finish converges
 * without a new bot token being minted on top of it.
 *
 * A metadata entry that names no revocable token id is dropped, because it is
 * the last stored copy of a secret that no revocation handle can reach.
 *
 * The webhook_secret and configured_webhooks stay, so a reconnect keeps the
 * existing webhook configuration.
 *
 * `actingUserId` is the user who requested the disconnect. It names the actor
 * for the credential lookup, which for an organization integration must be a
 * member of that organization.
 */
export async function disconnectGitLabIntegration(owner: Owner, actingUserId: string) {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  const actor = gitLabCredentialActor(owner, actingUserId);
  // The token service refuses a suspended integration, so the credential that
  // can revoke project tokens must be resolved before the suspension. It is
  // resolved even when no project token is visible yet: a review that is
  // already running can store one before the suspension commits.
  let userToken: string | undefined;
  try {
    userToken = await getValidGitLabToken(integration, actor);
  } catch (error) {
    logExceptInTest('[disconnectGitLabIntegration] Connected credential unavailable', {
      integrationId: integration.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const updatedMetadata = await db.transaction(async tx => {
    const nextMetadata = await mutateGitLabMetadataInTransaction(tx, integration.id, {
      delete: [
        'access_token',
        'refresh_token',
        'token_expires_at',
        'client_id',
        'client_secret',
        'auth_type',
      ],
    });
    await tx
      .update(platform_integrations)
      .set({
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));
    await tx
      .delete(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
    await tx
      .delete(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          isNull(platform_access_token_credentials.provider_resource_id)
        )
      );
    return nextMetadata;
  });

  // Settle after the suspension: nothing can mint a project token while the
  // integration is suspended, so the list read here also covers a token stored
  // between the first credential lookup and the suspension. The integration is
  // suspended already, so an unreadable project list cannot fail the disconnect;
  // the kept handles stay unusable through it.
  const settlement = await settleStoredProjectTokens(integration, actor, userToken);

  logExceptInTest(
    '[disconnectGitLabIntegration] Integration suspended (preserved webhook config)',
    {
      integrationId: integration.id,
      preservedWebhookSecret: !!updatedMetadata.webhook_secret,
      preservedWebhooks: countMetadataObjectEntries(updatedMetadata.configured_webhooks),
      revokedProjectTokens: settlement?.revoked ?? 0,
      scrubbedProjectTokens: settlement?.scrubbed ?? 0,
      retainedProjectTokens: settlement?.retained ?? 0,
      unsettledProjectTokens: settlement?.unattempted ?? 0,
      projectTokenListUnavailable: settlement === null,
    }
  );

  return { success: true };
}

/**
 * Regenerate webhook secret for a GitLab integration
 * This is useful when the user has lost the webhook secret and needs to reconfigure
 * their GitLab webhook settings.
 *
 * The new secret is merged into the stored metadata under the integration
 * lifecycle lock, so a concurrent connect or disconnect keeps its own fields.
 */
export async function regenerateWebhookSecret(owner: Owner): Promise<{ webhookSecret: string }> {
  const ownershipCondition = ownerCondition(owner);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  const newWebhookSecret = randomBytes(32).toString('hex');

  await mutateGitLabMetadata(integration.id, { set: { webhook_secret: newWebhookSecret } });

  return { webhookSecret: newWebhookSecret };
}

// ============================================================================
// Project Access Token (PrAT) Management
// ============================================================================

/** Legacy plaintext project credential retained only until backfill and scrub. */
export type StoredProjectAccessToken = {
  /** GitLab token ID (for rotation/revocation) */
  token_id: number;
  /** The token value retained only during the migration window. */
  token: string;
  /** Expiration date in YYYY-MM-DD format */
  expires_at: string;
  /** When the token was created */
  created_at: string;
  /** Token name for identification */
  name: string;
};

/**
 * GitLab integration metadata type with PrAT support
 */
export type GitLabIntegrationMetadata = {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  gitlab_instance_url?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
  auth_type?: 'oauth' | 'pat';
  /** Configured webhooks per project */
  configured_webhooks?: Record<
    string,
    {
      hook_id: number;
      created_at: string;
    }
  >;
  /** Project Access Tokens per project (keyed by project ID) */
  project_tokens?: Record<string, StoredProjectAccessToken>;
};

/**
 * Default name for Kilo Code Review Bot tokens
 */
const KILO_BOT_TOKEN_NAME = 'Kilo Code Review Bot';

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

/**
 * Drops one stored project token entry that a provider call cannot settle.
 * Returns true when it dropped one. Needs no provider credential.
 */
async function dropUnrevokableProjectTokenEntry(
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

async function getStoredProjectCredential(integrationId: string, projectId: string) {
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
    authorizedAccountId: parsed.data.provider_metadata.authorizedAccountId ?? null,
    unusable: parsed.data.provider_metadata.unusableReason !== undefined,
  } satisfies StoredProjectCredential;
}

async function validateStoredProjectAccessToken(
  token: string,
  instanceUrl: string
): Promise<GitLabProjectAccessTokenValidation> {
  const first = await validateProjectAccessToken(token, instanceUrl);
  if (first.status !== 'unverified') {
    return first;
  }

  // A rejected instance URL is a stored configuration problem: repeating the
  // probe cannot change the answer.
  if (first.reason === 'instance-url') {
    return first;
  }

  logExceptInTest('[validateStoredProjectAccessToken] Retrying unconfirmed token probe', {
    reason: first.reason,
    status: first.httpStatus,
  });
  return validateProjectAccessToken(token, instanceUrl);
}

/**
 * Gets or creates a Project Access Token for a GitLab project
 *
 * This function:
 * 1. Checks if an encrypted PrAT credential already exists for the project
 * 2. If exists and not expiring soon, returns it
 * 3. If exists but expiring soon, rotates it
 * 4. If doesn't exist, creates a new one
 *
 * Validation is best effort for transient provider failures; explicit denials
 * require replacement. Invalid instance configuration is reported to the caller.
 *
 * @param integration - The GitLab integration record
 * @param projectId - GitLab project ID
 * @returns The Project Access Token to use for API calls
 */
export async function getOrCreateProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GitLabCredentialActor
): Promise<string> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);
  const projectIdStr = requireGitLabProjectId(projectId);

  // Credential metadata is authoritative; the plaintext project map is migration-only.
  let storedCredential = await getStoredProjectCredential(integration.id, projectIdStr);
  const integratingAccountId = readGitLabAccountId(integration);

  if (integratingAccountId === null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: GITLAB_RECONNECT_REQUIRED_MESSAGE,
    });
  }

  if (storedCredential?.unusable) {
    logExceptInTest('[getOrCreateProjectAccessToken] Stored token is not usable', {
      projectId,
      tokenId: storedCredential.tokenId,
    });
    storedCredential = null;
  } else if (storedCredential && storedCredential.authorizedAccountId !== integratingAccountId) {
    const userToken = await getValidGitLabToken(integration, actor);
    await retireStoredProjectCredential({
      integrationId: integration.id,
      projectId: projectIdStr,
      credential: storedCredential,
      userToken,
      instanceUrl,
    });
    storedCredential = null;
  }

  if (storedCredential) {
    // Check if token is expiring soon (within 7 days)
    const isExpiringSoon = isProjectAccessTokenExpiringSoon(storedCredential.expiresAt, 7);

    if (!isExpiringSoon) {
      // Validate the token is still valid on GitLab (might have been manually revoked)
      const projectToken = await getValidGitLabProjectAccessToken(integration, projectIdStr, actor);
      const validation = await validateStoredProjectAccessToken(projectToken, instanceUrl);

      if (validation.status === 'unverified') {
        logExceptInTest('[getOrCreateProjectAccessToken] Token health is unconfirmed', {
          projectId,
          tokenId: storedCredential.tokenId,
          reason: validation.reason,
          status: validation.httpStatus,
        });
        if (validation.reason === 'instance-url') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'GitLab instance URL is invalid.',
          });
        }
      }

      if (validation.status !== 'invalid') {
        logExceptInTest('[getOrCreateProjectAccessToken] Using existing token', {
          projectId,
          tokenId: storedCredential.tokenId,
          expiresAt: storedCredential.expiresAt,
        });
        return projectToken;
      }

      // Token is denied or revoked, remove from storage and create a new one
      logExceptInTest(
        '[getOrCreateProjectAccessToken] Stored token is unusable, creating new one',
        {
          projectId,
          tokenId: storedCredential.tokenId,
          reason: validation.reason,
          status: validation.httpStatus,
        }
      );

      // Remove the invalid token from storage and skip to creating a new one
      await deleteStoredProjectCredential({
        integrationId: integration.id,
        projectId: projectIdStr,
        credential: storedCredential,
      });
      // Don't try to rotate - fall through to create new token below
    } else {
      // Token is expiring soon, try to rotate it
      logExceptInTest('[getOrCreateProjectAccessToken] Token expiring soon, rotating', {
        projectId,
        tokenId: storedCredential.tokenId,
        expiresAt: storedCredential.expiresAt,
      });

      let rotatedToken: GitLabProjectAccessToken | null = null;
      try {
        // Get a valid user token for the rotation API call
        const userToken = await getValidGitLabToken(integration, actor);
        const newExpiresAt = calculateProjectAccessTokenExpiry(365);

        rotatedToken = await rotateProjectAccessToken(
          userToken,
          projectId,
          storedCredential.tokenId,
          newExpiresAt,
          instanceUrl
        );

        // Token value is only returned on rotation
        if (!rotatedToken.token) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'GitLab did not return token value after rotation',
          });
        }
      } catch (error) {
        // If rotation fails, try to create a new token
        logExceptInTest('[getOrCreateProjectAccessToken] Rotation failed, creating new token', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (rotatedToken?.token) {
        // Keep persistence outside the provider fallback so a version conflict fails closed.
        await updateStoredProjectAccessToken(integration, projectIdStr, rotatedToken);

        logExceptInTest('[getOrCreateProjectAccessToken] Token rotated successfully', {
          projectId,
          newTokenId: rotatedToken.id,
          newExpiresAt: rotatedToken.expires_at,
        });

        return rotatedToken.token;
      }
    }
  }

  // No existing token or rotation failed, create a new one
  logExceptInTest('[getOrCreateProjectAccessToken] Creating new token', {
    projectId,
  });

  const userToken = await getValidGitLabToken(integration, actor);
  const expiresAt = calculateProjectAccessTokenExpiry(365);

  try {
    const newToken = await createProjectAccessToken(
      userToken,
      projectId,
      KILO_BOT_TOKEN_NAME,
      expiresAt,
      ['api', 'self_rotate'], // api for full access, self_rotate for token rotation
      30, // Developer access level
      instanceUrl
    );

    // Token value is only returned on creation
    if (!newToken.token) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'GitLab did not return token value after creation',
      });
    }

    await updateStoredProjectAccessToken(integration, projectIdStr, newToken);

    logExceptInTest('[getOrCreateProjectAccessToken] Token created successfully', {
      projectId,
      tokenId: newToken.id,
      expiresAt: newToken.expires_at,
    });

    return newToken.token;
  } catch (error) {
    if (error instanceof GitLabAuthenticationError) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message:
          'GitLab rejected the connected credential. Reconnect the GitLab integration and try again.',
        cause: error,
      });
    }
    if (error instanceof GitLabProjectAccessTokenPermissionError) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Cannot create bot token for project ${projectId}. You need Maintainer role or higher.`,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Stores only the exact encrypted project credential.
 */
async function updateStoredProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string,
  providerToken: GitLabProjectAccessToken
): Promise<void> {
  if (!providerToken.token) {
    throw new Error('GitLab project access token value is required');
  }
  const token = providerToken.token;
  const integrationType = integration.integration_type;
  if (integrationType !== 'oauth' && integrationType !== 'pat') {
    throw new Error('GitLab integration type must be OAuth or PAT');
  }

  const owner = getGitLabIntegrationOwner(integration);
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const providerBaseUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);
  const authorizedAccountId = readGitLabAccountId(integration);
  if (authorizedAccountId === null) {
    throw new Error('GitLab integration has no connected account');
  }
  const providerMetadata = GitLabProjectAccessTokenMetadataSchema.parse({
    providerCredentialId: String(providerToken.id),
    expiresOn: providerToken.expires_at,
    authorizedAccountId,
  });
  const validatedAt = new Date().toISOString();

  await db.transaction(async tx => {
    const currentMetadata = await readGitLabMetadataInTransaction(tx, integration.id);
    const currentProviderBaseUrl = normalizeInstanceUrl(
      readOptionalMetadataString(currentMetadata, 'gitlab_instance_url')
    );
    const currentIntegrationType = readOptionalMetadataString(currentMetadata, 'auth_type');
    if (currentProviderBaseUrl !== providerBaseUrl || currentIntegrationType !== integrationType) {
      throw new Error('GitLab integration changed while storing project credential');
    }
    const [currentIntegration] = await tx
      .select({
        platform_account_id: platform_integrations.platform_account_id,
        platform_installation_id: platform_integrations.platform_installation_id,
      })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, integration.id),
          eq(platform_integrations.platform, PLATFORM.GITLAB)
        )
      )
      .limit(1);
    if (!currentIntegration || readGitLabAccountId(currentIntegration) !== authorizedAccountId) {
      throw new Error('GitLab integration changed while storing project credential');
    }
    const [existingCredential] = await tx
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token'),
          eq(platform_access_token_credentials.provider_resource_id, projectId)
        )
      )
      .limit(1);
    const credentialId = existingCredential?.id ?? randomUUID();
    const credentialVersion = (existingCredential?.credential_version ?? 0) + 1;
    const tokenEncrypted = encryptGitLabProjectAccessToken({
      token,
      credentialId,
      integrationId: integration.id,
      providerBaseUrl,
      owner,
      providerResourceId: projectId,
      credentialVersion,
    });

    if (existingCredential) {
      const updatedCredential = await tx
        .update(platform_access_token_credentials)
        .set({
          token_encrypted: tokenEncrypted,
          expires_at: null,
          provider_credential_type: 'project_access_token',
          provider_resource_id: projectId,
          provider_base_url: providerBaseUrl,
          authorized_by_user_id: null,
          provider_metadata: providerMetadata,
          provider_scopes: providerToken.scopes,
          provider_verified_at: validatedAt,
          credential_version: credentialVersion,
          last_validated_at: validatedAt,
        })
        .where(
          and(
            eq(platform_access_token_credentials.id, existingCredential.id),
            eq(
              platform_access_token_credentials.credential_version,
              existingCredential.credential_version
            )
          )
        )
        .returning({ id: platform_access_token_credentials.id });
      if (updatedCredential.length !== 1) {
        throw new Error('GitLab project access token was replaced concurrently');
      }
      return;
    }

    await tx.insert(platform_access_token_credentials).values({
      id: credentialId,
      platform_integration_id: integration.id,
      token_encrypted: tokenEncrypted,
      expires_at: null,
      provider_credential_type: 'project_access_token',
      provider_resource_id: projectId,
      provider_base_url: providerBaseUrl,
      authorized_by_user_id: null,
      provider_metadata: providerMetadata,
      provider_scopes: providerToken.scopes,
      provider_verified_at: validatedAt,
      credential_version: credentialVersion,
      last_validated_at: validatedAt,
    });
  });
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
 * `userToken` lets a caller that already resolved the connected credential — a
 * disconnect resolves it before the integration stops counting as connected —
 * reuse it instead of asking the token service per project. `signal` carries
 * that caller's deadline into the provider request.
 */
export async function removeStoredProjectAccessToken(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  projectId: string | number,
  actor: GitLabCredentialActor,
  options: { userToken?: string; signal?: AbortSignal } = {}
): Promise<StoredProjectTokenRemoval> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
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
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);

  try {
    const userToken = options.userToken ?? (await getValidGitLabToken(integration, actor));
    for (const tokenId of tokenIds) {
      await revokeProjectAccessToken(userToken, projectId, tokenId, instanceUrl, options.signal);
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
 * Finds an existing Kilo bot token on GitLab and imports it into metadata
 * Useful for recovering from lost metadata or migrating existing tokens
 */
export async function importExistingProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GitLabCredentialActor
): Promise<GitLabProjectAccessToken | null> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);
  const userToken = await getValidGitLabToken(integration, actor);

  const existingToken = await findKiloProjectAccessToken(
    userToken,
    projectId,
    KILO_BOT_TOKEN_NAME,
    instanceUrl
  );

  if (existingToken) {
    logExceptInTest('[importExistingProjectAccessToken] Found existing token on GitLab', {
      projectId,
      tokenId: existingToken.id,
      expiresAt: existingToken.expires_at,
    });

    // Note: We can't get the token value from the API, only on creation
    // So we can only store the metadata, not the actual token
    // The caller will need to rotate the token to get a new value
  }

  return existingToken;
}

// ============================================================================
// Personal Access Token (PAT) Connection
// ============================================================================

/**
 * Re-export validatePersonalAccessToken for use in tRPC router
 */
export { validatePersonalAccessToken, type GitLabPATValidationResult };

const GITLAB_REPOSITORY_SYNC_WARNING =
  'Connected, but the repository list could not be loaded. Refresh the project list from the GitLab integration page.';

/**
 * Caches the connected account's repositories after the integration row and
 * credential are committed.
 *
 * A provider refusal here says nothing about the connection itself, so it is
 * reported as a warning on the successful result instead of failing the
 * connect. A new connection, or one whose previous list was dropped, then has
 * no cached list, so the next repository-list read refetches it (see
 * `listGitLabRepositories`); a same-instance reconnect keeps its last
 * successful list until the user refreshes it.
 *
 * `discardOnFailure` is for an instance change: the cached rows belong to the
 * previous GitLab instance, so they are dropped rather than shown against a
 * credential that cannot reach them.
 */
async function cacheConnectedGitLabRepositories(
  integrationId: string,
  token: string,
  instanceUrl: string,
  discardOnFailure: boolean
): Promise<string | undefined> {
  try {
    const repos = await fetchGitLabProjects(token, instanceUrl);
    await updateRepositoriesForIntegration(integrationId, repos);
    logExceptInTest('[connectWithPAT] Repositories cached', {
      integrationId,
      repoCount: repos.length,
    });
    return undefined;
  } catch (error) {
    logExceptInTest('[connectWithPAT] Repository sync failed after commit', {
      integrationId,
      error: error instanceof Error ? error.message : String(error),
      discardOnFailure,
    });
    if (discardOnFailure) {
      try {
        await db
          .update(platform_integrations)
          .set({ repositories: null, repositories_synced_at: null })
          .where(eq(platform_integrations.id, integrationId));
      } catch (clearError) {
        logExceptInTest('[connectWithPAT] Failed to discard stale repositories', {
          integrationId,
          error: clearError instanceof Error ? clearError.message : String(clearError),
        });
      }
    }
    return GITLAB_REPOSITORY_SYNC_WARNING;
  }
}

/**
 * Connects GitLab using a Personal Access Token
 *
 * This is an alternative to OAuth for users who prefer PAT-based auth.
 * The PAT is used for:
 * - Account connection and identity verification
 * - Listing accessible repositories
 * - Creating webhooks (requires Maintainer role)
 * - Creating Project Access Tokens for code reviews
 *
 * Code reviews use Project Access Tokens (PrAT) so comments appear as a bot.
 *
 * If an existing integration exists, this function will update it instead of
 * creating a new one. This preserves webhook secrets and configured webhooks
 * so existing webhook configurations continue to work.
 * Replacing a credential clears its authentication invalidation in the same
 * transaction; connection health does not depend on the repository-cache sync.
 *
 * Reconnecting a suspended integration of the same account on the same instance
 * settles the project access tokens a disconnect could not revoke. The
 * presented credential is the only one that can revoke them, so this is the
 * point where a partially completed disconnect converges.
 *
 * @param owner - User or organization owner
 * @param token - Personal Access Token
 * @param instanceUrl - GitLab instance URL
 * @param authorizedByUserId - Authenticated Kilo user who supplied the PAT
 */
export async function connectWithPAT(
  owner: Owner,
  token: string,
  instanceUrl: string = 'https://gitlab.com',
  authorizedByUserId: string
): Promise<{
  success: boolean;
  integration: {
    id: string;
    accountLogin: string;
    accountId: string;
    instanceUrl: string;
  };
  warnings?: string[];
}> {
  let normalizedInstanceUrl: string;
  try {
    normalizedInstanceUrl = normalizeInstanceUrl(instanceUrl);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        error instanceof GitLabInstanceUrlError ? error.message : 'Invalid GitLab instance URL',
    });
  }

  // 1. Validate the PAT
  const validation = await validatePersonalAccessToken(token, normalizedInstanceUrl);

  if (!validation.valid || !validation.user) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: validation.error || 'Invalid Personal Access Token',
    });
  }
  const validatedUser = validation.user;
  const validatedAt = new Date().toISOString();
  const providerMetadata = GitLabPersonalAccessTokenMetadataSchema.parse({
    providerCredentialId:
      validation.tokenInfo?.id === undefined ? undefined : String(validation.tokenInfo.id),
    expiresOn: validation.tokenInfo?.expiresAt ?? undefined,
  });

  // 2. Check for existing integration - update it instead of creating new
  const existingIntegration = await getGitLabIntegration(owner);

  if (existingIntegration) {
    let existingMetadata: Record<string, unknown> = {};
    let isInstanceChange = false;
    let isAccountChange = false;
    const existingAccountId = readGitLabAccountId(existingIntegration);
    const connectedAccountId = String(validatedUser.id);
    if (
      existingIntegration.integration_status === INTEGRATION_STATUS.SUSPENDED &&
      !instanceUrlChanged(
        readOptionalMetadataString(
          requireMetadataRecord(existingIntegration.metadata),
          'gitlab_instance_url'
        ),
        normalizedInstanceUrl
      ) &&
      (existingAccountId === null || existingAccountId === connectedAccountId)
    ) {
      const settlement = await settleStoredProjectTokens(
        existingIntegration,
        gitLabCredentialActor(owner, authorizedByUserId),
        token
      );
      logExceptInTest('[connectWithPAT] Reconnect settled retained project tokens', {
        integrationId: existingIntegration.id,
        settledProjectTokens: settlement === null ? null : settlement,
      });
    }

    await db.transaction(async tx => {
      existingMetadata = await readGitLabMetadataInTransaction(tx, existingIntegration.id);
      isInstanceChange = instanceUrlChanged(
        readOptionalMetadataString(existingMetadata, 'gitlab_instance_url'),
        normalizedInstanceUrl
      );
      isAccountChange =
        !isInstanceChange && existingAccountId !== null && existingAccountId !== connectedAccountId;
      const [existingPrimaryCredential] = await tx
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, existingIntegration.id),
            isNull(platform_access_token_credentials.provider_resource_id)
          )
        )
        .limit(1);
      const credentialId = existingPrimaryCredential?.id ?? randomUUID();
      const credentialVersion = (existingPrimaryCredential?.credential_version ?? 0) + 1;
      const tokenEncrypted = encryptGitLabPersonalAccessToken({
        token,
        credentialId,
        integrationId: existingIntegration.id,
        providerBaseUrl: normalizedInstanceUrl,
        owner,
        authorizedByUserId,
        credentialVersion,
      });

      await mutateGitLabMetadataInTransaction(tx, existingIntegration.id, {
        set: {
          gitlab_instance_url: normalizedInstanceUrl,
          auth_type: 'pat',
          webhook_secret: isInstanceChange
            ? randomBytes(32).toString('hex')
            : (readOptionalMetadataString(existingMetadata, 'webhook_secret') ??
              randomBytes(32).toString('hex')),
        },
        delete: [
          'access_token',
          'refresh_token',
          'token_expires_at',
          'client_id',
          'client_secret',
          ...(isInstanceChange ? ['configured_webhooks', 'project_tokens'] : []),
          ...(isAccountChange ? ['project_tokens'] : []),
        ],
      });

      await tx
        .update(platform_integrations)
        .set({
          integration_type: 'pat',
          platform_installation_id: String(validatedUser.id),
          platform_account_id: String(validatedUser.id),
          platform_account_login: validatedUser.username,
          scopes: validation.tokenInfo?.scopes ?? ['api'],
          integration_status: INTEGRATION_STATUS.ACTIVE,
          auth_invalid_at: null,
          auth_invalid_reason: null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(platform_integrations.id, existingIntegration.id));

      if (isInstanceChange) {
        await tx
          .delete(platform_access_token_credentials)
          .where(
            eq(platform_access_token_credentials.platform_integration_id, existingIntegration.id)
          );
      }

      if (existingPrimaryCredential && !isInstanceChange) {
        const updatedCredential = await tx
          .update(platform_access_token_credentials)
          .set({
            token_encrypted: tokenEncrypted,
            expires_at: null,
            provider_credential_type: 'personal_access_token',
            provider_resource_id: null,
            provider_base_url: normalizedInstanceUrl,
            authorized_by_user_id: authorizedByUserId,
            provider_metadata: providerMetadata,
            provider_scopes: validation.tokenInfo?.scopes ?? null,
            provider_verified_at: validatedAt,
            credential_version: credentialVersion,
            last_validated_at: validatedAt,
          })
          .where(
            and(
              eq(platform_access_token_credentials.id, existingPrimaryCredential.id),
              eq(
                platform_access_token_credentials.credential_version,
                existingPrimaryCredential.credential_version
              )
            )
          )
          .returning({ id: platform_access_token_credentials.id });
        if (updatedCredential.length !== 1) {
          throw new Error('GitLab PAT was replaced concurrently');
        }
      } else {
        await tx.insert(platform_access_token_credentials).values({
          id: credentialId,
          platform_integration_id: existingIntegration.id,
          token_encrypted: tokenEncrypted,
          expires_at: null,
          provider_credential_type: 'personal_access_token',
          provider_resource_id: null,
          provider_base_url: normalizedInstanceUrl,
          authorized_by_user_id: authorizedByUserId,
          provider_metadata: providerMetadata,
          provider_scopes: validation.tokenInfo?.scopes ?? null,
          provider_verified_at: validatedAt,
          credential_version: credentialVersion,
          last_validated_at: validatedAt,
        });
      }

      await tx
        .delete(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, existingIntegration.id));
    });

    if (isInstanceChange) {
      logExceptInTest('[connectWithPAT] Instance URL changed — clearing stale config', {
        integrationId: existingIntegration.id,
        oldInstanceUrl: readOptionalMetadataString(existingMetadata, 'gitlab_instance_url'),
        newInstanceUrl: normalizedInstanceUrl,
      });
    }

    if (isAccountChange) {
      const retirement = await retireProjectCredentialsForReplacedAccount({
        integrationId: existingIntegration.id,
        userToken: token,
        instanceUrl: normalizedInstanceUrl,
        currentAccountId: connectedAccountId,
      });
      logExceptInTest('[connectWithPAT] Connected account changed — retired project credentials', {
        integrationId: existingIntegration.id,
        retired: retirement.retired,
        retained: retirement.retained,
      });
    }

    if (isInstanceChange || isAccountChange) {
      await resetCodeReviewConfigForOwner(owner, PLATFORM.GITLAB);
    }

    logExceptInTest('[connectWithPAT] Integration updated', {
      integrationId: existingIntegration.id,
      userId: validatedUser.id,
      username: validatedUser.username,
      instanceUrl: normalizedInstanceUrl,
      authType: 'pat',
      instanceChanged: isInstanceChange,
      preservedWebhookSecret:
        !isInstanceChange && !!readOptionalMetadataString(existingMetadata, 'webhook_secret'),
      preservedWebhooks: isInstanceChange
        ? 0
        : countMetadataObjectEntries(existingMetadata.configured_webhooks),
    });

    // Fetch and cache repositories. The connection is already committed, so a
    // repository-list failure is a warning from here on, never a failed connect.
    const syncWarning = await cacheConnectedGitLabRepositories(
      existingIntegration.id,
      token,
      normalizedInstanceUrl,
      isInstanceChange
    );

    return {
      success: true,
      integration: {
        id: existingIntegration.id,
        accountLogin: validatedUser.username,
        accountId: String(validatedUser.id),
        instanceUrl: normalizedInstanceUrl,
      },
      warnings: [...(validation.warnings ?? []), ...(syncWarning ? [syncWarning] : [])],
    };
  }

  // 3. No existing integration - create new one with fresh webhook secret
  const webhookSecret = randomBytes(32).toString('hex');

  // 4. Prepare metadata
  const metadata: GitLabIntegrationMetadata = {
    // No refresh_token for PAT (PATs don't refresh)
    gitlab_instance_url: normalizedInstanceUrl,
    webhook_secret: webhookSecret,
    auth_type: 'pat',
  };

  const integrationId = randomUUID();
  const credentialId = randomUUID();
  const credentialVersion = 1;
  const tokenEncrypted = encryptGitLabPersonalAccessToken({
    token,
    credentialId,
    integrationId,
    providerBaseUrl: normalizedInstanceUrl,
    owner,
    authorizedByUserId,
    credentialVersion,
  });

  // 5. Create the parent and encrypted credential atomically.
  const integration = await db.transaction(async tx => {
    const [createdIntegration] = await tx
      .insert(platform_integrations)
      .values({
        id: integrationId,
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform: PLATFORM.GITLAB,
        integration_type: 'pat',
        platform_installation_id: String(validatedUser.id), // Use GitLab user ID as "installation" ID
        platform_account_id: String(validatedUser.id),
        platform_account_login: validatedUser.username,
        permissions: null, // PAT doesn't have granular permissions like GitHub Apps
        scopes: validation.tokenInfo?.scopes ?? ['api'],
        repository_access: 'all', // PAT grants access to all user's projects
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        installed_at: validatedAt,
      })
      .returning();

    await tx.insert(platform_access_token_credentials).values({
      id: credentialId,
      platform_integration_id: integrationId,
      token_encrypted: tokenEncrypted,
      expires_at: null,
      provider_credential_type: 'personal_access_token',
      provider_resource_id: null,
      provider_base_url: normalizedInstanceUrl,
      authorized_by_user_id: authorizedByUserId,
      provider_metadata: providerMetadata,
      provider_scopes: validation.tokenInfo?.scopes ?? null,
      provider_verified_at: validatedAt,
      credential_version: credentialVersion,
      last_validated_at: validatedAt,
    });
    await tx
      .delete(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integrationId));

    return createdIntegration;
  });

  logExceptInTest('[connectWithPAT] Integration created', {
    integrationId: integration.id,
    userId: validatedUser.id,
    username: validatedUser.username,
    instanceUrl: normalizedInstanceUrl,
    authType: 'pat',
  });

  // 6. Fetch and cache repositories. The integration is committed above, so a
  // repository-list failure is a warning from here on, never a failed connect.
  const syncWarning = await cacheConnectedGitLabRepositories(
    integration.id,
    token,
    normalizedInstanceUrl,
    false
  );

  return {
    success: true,
    integration: {
      id: integration.id,
      accountLogin: validatedUser.username,
      accountId: String(validatedUser.id),
      instanceUrl: normalizedInstanceUrl,
    },
    warnings: [...(validation.warnings ?? []), ...(syncWarning ? [syncWarning] : [])],
  };
}
