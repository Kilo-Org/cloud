/**
 * Server-derived GitLab credentials for the MR review layer.
 *
 * A caller supplies an owner, a project path, and an optional display-only
 * instance hint. The instance URL and the token are resolved here and only
 * here: the hint is compared against the connected instance and never used
 * to build a request. A pasted self-managed URL therefore can never
 * re-target a connected token at another host.
 */
import 'server-only';

import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  gitlabInstanceOrigin,
  isNetworkFailure,
  ProviderApiStatusError,
  ProviderReviewError,
  type ProviderReviewErrorKind,
} from '@kilocode/app-shared/provider-review';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { requireNumericPlatformRepositories } from '@/lib/integrations/core/types';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import {
  DEFAULT_GITLAB_INSTANCE_URL,
  GitLabInstanceUrlError,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * The account that owns the GitLab integration. `userId` is the acting user
 * whose credential the token broker releases (the owner id for a user).
 */
export type GitLabReviewOwner =
  | { type: 'user'; userId: string }
  | { type: 'organization'; organizationId: string; userId: string };

export type GitLabReviewErrorKind = ProviderReviewErrorKind;

/**
 * A classified provider failure. `retryable` is true only for 5xx/network
 * outcomes. The message is fixed copy and never embeds a token or an
 * instance URL, so every output of this layer is safe to show or log.
 *
 * `providerStatus` keeps the HTTP status a failure was classified from, when
 * there was one, so an owner-aware caller can tell a refused credential (401)
 * from a provider permission refusal (403) after classification.
 */
export class GitLabReviewError extends ProviderReviewError {
  readonly providerStatus: number | null;

  constructor(
    kind: ProviderReviewErrorKind,
    message: string,
    providerStatus: number | null = null
  ) {
    super(kind, message);
    this.name = 'GitLabReviewError';
    this.providerStatus = providerStatus;
  }
}

/** An HTTP failure raised by this layer's own GitLab JSON requests. */
export class GitLabApiStatusError extends ProviderApiStatusError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'GitLabApiStatusError';
  }
}

/**
 * GitLab status → kind: 404 not_found, 401 reconnect, 403 forbidden, 409 stale
 * head, 5xx/429 retryable.
 *
 * A 401 is the credential this layer minted being refused, so the remedy is a
 * reconnect; 403 is a refusal of the role behind that credential, which
 * `classifyGitLabErrorForOwner` weighs against the connection's owner.
 */
export function classifyGitLabStatus(status: number): GitLabReviewError {
  if (status === 404) {
    return new GitLabReviewError(
      'not_found',
      'The GitLab merge request or project was not found, or you do not have access to it.',
      status
    );
  }
  if (status === 401) {
    return new GitLabReviewError(
      'reconnect',
      'Your GitLab connection is no longer valid. Reconnect GitLab and try again.',
      status
    );
  }
  if (status === 403) {
    return new GitLabReviewError(
      'forbidden',
      'Your GitLab role does not allow this action on this merge request.',
      status
    );
  }
  if (status === 409) {
    return new GitLabReviewError(
      'stale_head',
      'The merge request changed since it was loaded. Reload the merge request and try again.',
      status
    );
  }
  if (status === 400 || status === 405 || status === 422) {
    return new GitLabReviewError('bad_request', 'GitLab rejected this request.', status);
  }
  if (status === 429 || status >= 500) {
    return new GitLabReviewError(
      'retryable',
      'GitLab is temporarily unavailable. Try again.',
      status
    );
  }
  return new GitLabReviewError('retryable', 'GitLab returned an unexpected error.', status);
}

function classifyTrpcError(code: TRPCError['code']): GitLabReviewError {
  switch (code) {
    case 'NOT_FOUND':
      return new GitLabReviewError('not_found', 'GitLab integration not found.');
    case 'UNAUTHORIZED':
      // The credential broker refused the stored credential: the connection
      // must be re-established. The caller's organization access is intact.
      return new GitLabReviewError(
        'reconnect',
        'Your GitLab connection is no longer valid. Reconnect GitLab and try again.'
      );
    case 'SERVICE_UNAVAILABLE':
      return new GitLabReviewError('retryable', 'GitLab credentials are temporarily unavailable.');
    default:
      return new GitLabReviewError('retryable', 'Could not resolve your GitLab credentials.');
  }
}

/**
 * Map one provider failure onto the mobile error states.
 *
 * The adapter helpers throw plain Errors whose message ends with the status
 * code (e.g. `GitLab MR fetch failed: 403`); the status number is the only
 * provider detail that survives here, so no response body — and no token —
 * can leak into the classified message.
 */
export function classifyGitLabError(error: unknown): GitLabReviewError {
  if (error instanceof GitLabReviewError) return error;
  if (error instanceof GitLabInstanceUrlError) {
    return new GitLabReviewError('bad_request', 'The GitLab instance URL is not allowed.');
  }
  if (error instanceof TRPCError) {
    return classifyTrpcError(error.code);
  }
  if (error instanceof GitLabApiStatusError) {
    return classifyGitLabStatus(error.status);
  }
  if (error instanceof Error) {
    const status = error.message.match(/:\s*(\d{3})\b/);
    if (status?.[1]) {
      return classifyGitLabStatus(Number(status[1]));
    }
    if (isNetworkFailure(error)) {
      return new GitLabReviewError('retryable', 'Could not reach GitLab. Please try again.');
    }
  }
  logExceptInTest('[gitlab-authorization] Unclassified GitLab failure:', error);
  return new GitLabReviewError('retryable', 'GitLab returned an unexpected error.');
}

/**
 * Classify one READ failure for the account whose connection produced the
 * credential.
 *
 * The token belongs to the CONNECTION: for an organization integration it is
 * the organization's credential, and the person reading the merge request has
 * no GitLab role in play. A provider 403 on such a read is therefore the
 * connection's refusal — it cannot read that project — and its remedy is
 * reconnecting, not the reader's permission. A personal connection's 403 is
 * the caller's own GitLab role, and stays `forbidden`.
 *
 * Reads only: a 403 on a WRITE is an action-level refusal (self-approval, a
 * protected branch, a role the connected identity lacks), which reconnecting
 * cannot fix, so the write path keeps `classifyGitLabError`. A refused
 * credential (401) is `reconnect` on both paths.
 */
export function classifyGitLabErrorForOwner(
  error: unknown,
  owner: GitLabReviewOwner
): GitLabReviewError {
  const classified = classifyGitLabError(error);
  if (
    classified.kind === 'forbidden' &&
    classified.providerStatus === 403 &&
    owner.type === 'organization'
  ) {
    return new GitLabReviewError(
      'reconnect',
      'Your GitLab connection cannot read this merge request. Reconnect GitLab and try again.'
    );
  }
  return classified;
}

/** The credentials and canonical project path one request may use. */
export type GitLabProjectAccess = {
  accessToken: string;
  /** Server-derived instance base URL — never a caller-supplied value. */
  instanceUrl: string;
  /** The integration's repository full path, matched case-insensitively. */
  projectPath: string;
  owner: GitLabReviewOwner;
};

function ownerToDbOwner(owner: GitLabReviewOwner): Owner {
  return owner.type === 'user'
    ? { type: 'user', id: owner.userId }
    : { type: 'org', id: owner.organizationId };
}

function actorFor(owner: GitLabReviewOwner): { userId: string; organizationId?: string } {
  return owner.type === 'user'
    ? { userId: owner.userId }
    : { userId: owner.userId, organizationId: owner.organizationId };
}

function readInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata;
  const raw =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? (metadata as { gitlab_instance_url?: unknown }).gitlab_instance_url
      : undefined;
  // Same rule as gitlab-integration-helpers.ts:128,182 — the stored metadata
  // is the only source, and an absent URL means gitlab.com.
  const instanceUrl = typeof raw === 'string' && raw ? raw : DEFAULT_GITLAB_INSTANCE_URL;
  try {
    return normalizeGitLabInstanceUrl(instanceUrl);
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * The active integration row plus the server-derived instance URL, with the
 * instance-hint origin guard applied. Throws a GitLabReviewError on every
 * refusal; a hint whose origin differs is refused as not_found.
 */
async function resolveIntegration(
  owner: GitLabReviewOwner,
  instanceHint?: string
): Promise<{ integration: PlatformIntegration; instanceUrl: string }> {
  const integration = await getIntegrationForOwner(ownerToDbOwner(owner), PLATFORM.GITLAB);
  if (!integration) {
    throw new GitLabReviewError(
      'not_found',
      'No GitLab connection found for this account. Connect GitLab first.'
    );
  }
  if (integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
    throw new GitLabReviewError('not_found', 'The GitLab connection is no longer active.');
  }

  const instanceUrl = readInstanceUrl(integration);
  if (instanceHint && gitlabInstanceOrigin(instanceHint) !== gitlabInstanceOrigin(instanceUrl)) {
    // A pasted self-managed URL must never re-target the connected token to
    // another host: refuse as not-found without revealing the instance.
    throw new GitLabReviewError(
      'not_found',
      'This merge request is not available on your connected GitLab instance.'
    );
  }
  return { integration, instanceUrl };
}

/**
 * Resolve the active integration for the owner and return a fresh token plus
 * the server-derived instance URL. The inbox has no project to verify, so it
 * uses this instead of authorizeProject.
 */
export async function authorizeOwner(
  owner: GitLabReviewOwner,
  instanceHint?: string
): Promise<{ accessToken: string; instanceUrl: string; owner: GitLabReviewOwner }> {
  const { integration, instanceUrl } = await resolveIntegration(owner, instanceHint);
  try {
    const accessToken = await getValidGitLabToken(integration, actorFor(owner));
    return { accessToken, instanceUrl, owner };
  } catch (error) {
    throw classifyGitLabErrorForOwner(error, owner);
  }
}

function cleanProjectPath(projectPath: string): string {
  return projectPath.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Verify the project path is among the integration's repositories with the
 * same case-insensitive exact full-path match as
 * validateGitLabRepoAccessForUser/Organization
 * (gitlab-integration-helpers.ts:219-259). Nested `group/sub/repo` must
 * match end-to-end. Returns the server-derived token, instance URL, and the
 * integration's canonical project path.
 */
export async function authorizeProject(
  owner: GitLabReviewOwner,
  projectPath: string,
  instanceHint?: string
): Promise<GitLabProjectAccess> {
  const requested = cleanProjectPath(projectPath);
  const { integration, instanceUrl } = await resolveIntegration(owner, instanceHint);

  let repositories: ReturnType<typeof requireNumericPlatformRepositories>;
  try {
    repositories = requireNumericPlatformRepositories(integration.repositories);
  } catch {
    repositories = null;
  }
  const match = repositories?.find(
    repo => repo.full_name.toLowerCase() === requested.toLowerCase()
  );
  if (!match) {
    throw new GitLabReviewError(
      'not_found',
      'This project is not part of your connected GitLab repositories.'
    );
  }

  try {
    const accessToken = await getValidGitLabToken(integration, actorFor(owner));
    return { accessToken, instanceUrl, projectPath: match.full_name, owner };
  } catch (error) {
    throw classifyGitLabErrorForOwner(error, owner);
  }
}
