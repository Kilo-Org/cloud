/**
 * Server-derived Bitbucket Cloud credentials for the PR review layer.
 *
 * Bitbucket Cloud exists in an organization context only — there is no
 * personal Bitbucket integration. A caller supplies an owner, a workspace
 * slug, and a repository slug; the workspace identity (UUID + slug), the
 * repository identity (UUID + full name), and the workspace access token are
 * resolved here and only here. The workspace access token never leaves the
 * web process in plaintext form: it is brokered from the git-token-service,
 * which holds the private credential key, so a caller can never re-target the
 * layer at another workspace by pasting an identity.
 */
import 'server-only';

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { BITBUCKET_WORKSPACE_ACCESS_TOKEN_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';
import {
  getBitbucketWorkspaceAccessTokenStatus,
  readCachedBitbucketWorkspaceAccessTokenRepositories,
} from '@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * The account that owns the review context. Bitbucket Cloud is supported in
 * organization context only, so a user owner is refused with a clear
 * not-found error that names the organization requirement.
 */
export type BitbucketReviewOwner =
  | { type: 'user'; userId: string }
  | { type: 'organization'; organizationId: string; userId: string };

/**
 * The explicit org-only unavailable state, shared by every refusal site (this
 * layer, the branch listing, and the routers) so the copy never drifts.
 */
export const BITBUCKET_ORGANIZATION_ONLY_MESSAGE =
  'Bitbucket pull requests are available in an organization context only. Switch to an organization with a connected Bitbucket workspace.';

export type BitbucketReviewErrorKind =
  | 'not_found'
  | 'forbidden'
  | 'stale_head'
  | 'bad_request'
  | 'retryable';

/**
 * A classified provider failure. `retryable` is true only for 5xx/network
 * outcomes. The message is fixed copy and never embeds a token or a
 * workspace identity, so every output of this layer is safe to show or log.
 */
export class BitbucketReviewError extends Error {
  readonly kind: BitbucketReviewErrorKind;
  readonly retryable: boolean;

  constructor(kind: BitbucketReviewErrorKind, message: string) {
    super(message);
    this.name = 'BitbucketReviewError';
    this.kind = kind;
    this.retryable = kind === 'retryable';
  }
}

/** An HTTP failure raised by this layer's own Bitbucket JSON requests. */
export class BitbucketApiStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'BitbucketApiStatusError';
  }
}

/**
 * Bitbucket status → kind: 404 not_found, 401/403 forbidden, 409 stale head,
 * 400/405/422 bad request, 5xx/429 retryable.
 */
export function classifyBitbucketStatus(status: number): BitbucketReviewError {
  if (status === 404) {
    return new BitbucketReviewError(
      'not_found',
      'The Bitbucket pull request or repository was not found, or you do not have access to it.'
    );
  }
  if (status === 401 || status === 403) {
    return new BitbucketReviewError(
      'forbidden',
      'Your Bitbucket workspace access does not allow this action on this pull request.'
    );
  }
  if (status === 409) {
    return new BitbucketReviewError(
      'stale_head',
      'The pull request changed since it was loaded. Reload the pull request and try again.'
    );
  }
  if (status === 400 || status === 405 || status === 422) {
    return new BitbucketReviewError('bad_request', 'Bitbucket rejected this request.');
  }
  if (status === 429 || status >= 500) {
    return new BitbucketReviewError(
      'retryable',
      'Bitbucket is temporarily unavailable. Try again.'
    );
  }
  return new BitbucketReviewError('retryable', 'Bitbucket returned an unexpected error.');
}

function isNetworkFailure(error: Error): boolean {
  return (
    error.name === 'TypeError' ||
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    error.message.toLowerCase().includes('fetch failed')
  );
}

function classifyTrpcError(code: TRPCError['code']): BitbucketReviewError {
  switch (code) {
    case 'NOT_FOUND':
      return new BitbucketReviewError('not_found', 'Bitbucket integration not found.');
    case 'UNAUTHORIZED':
      return new BitbucketReviewError('forbidden', 'Your Bitbucket connection is no longer valid.');
    case 'SERVICE_UNAVAILABLE':
      return new BitbucketReviewError(
        'retryable',
        'Bitbucket credentials are temporarily unavailable.'
      );
    default:
      return new BitbucketReviewError('retryable', 'Could not resolve your Bitbucket credentials.');
  }
}

/**
 * Map one provider failure onto the mobile error states. The fixed-copy
 * contract matches gitlab-authorization: only the status code survives from a
 * provider failure, so no response body — and no token — can leak into the
 * classified message.
 */
export function classifyBitbucketError(error: unknown): BitbucketReviewError {
  if (error instanceof BitbucketReviewError) return error;
  if (error instanceof TRPCError) {
    return classifyTrpcError(error.code);
  }
  if (error instanceof BitbucketApiStatusError) {
    return classifyBitbucketStatus(error.status);
  }
  if (error instanceof Error) {
    const status = error.message.match(/:\s*(\d{3})\b/);
    if (status?.[1]) {
      return classifyBitbucketStatus(Number(status[1]));
    }
    if (isNetworkFailure(error)) {
      return new BitbucketReviewError('retryable', 'Could not reach Bitbucket. Please try again.');
    }
  }
  logExceptInTest('[bitbucket-authorization] Unclassified Bitbucket failure:', error);
  return new BitbucketReviewError('retryable', 'Bitbucket returned an unexpected error.');
}

/** The connected workspace identity of the organization integration. */
export type BitbucketWorkspace = { uuid: string; slug: string };

export type BitbucketRepositoryIdentity = {
  /** The provider repository UUID from the integration's repository cache. */
  uuid: string;
  slug: string;
  fullName: string;
};

/** The credentials and canonical workspace identity one workspace request may use. */
export type BitbucketWorkspaceAccess = {
  accessToken: string;
  workspace: BitbucketWorkspace;
  owner: BitbucketReviewOwner;
};

/** The credentials and resolved repository identity one repository request may use. */
export type BitbucketRepositoryAccess = BitbucketWorkspaceAccess & {
  repository: BitbucketRepositoryIdentity;
};

/**
 * The audience the review layer mints its internal service token for when it
 * asks the git-token-service to release the workspace access token. The
 * git-token-service holds the private credential key — the web process stores
 * the token only as a public-key envelope — so the release endpoint is the
 * only path that can hand a usable Bitbucket token to this layer. The
 * endpoint (POST {GIT_TOKEN_SERVICE_API_URL}/internal/bitbucket/workspace-access-token)
 * mirrors the GitLab credential broker: it verifies this operation-specific
 * audience, re-resolves the integration for the org, decrypts the credential,
 * and re-checks the workspace identity before answering. The audience string
 * lives in @kilocode/worker-utils/internal-service-token-audiences next to the
 * endpoint so both sides import one constant.
 */
export { BITBUCKET_WORKSPACE_ACCESS_TOKEN_AUDIENCE };

const BITBUCKET_WORKSPACE_ACCESS_TOKEN_RELEASE_PATH = '/internal/bitbucket/workspace-access-token';
const BITBUCKET_WORKSPACE_ACCESS_TOKEN_RESPONSE_MAX_BYTES = 16_384;
const BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

const BitbucketWorkspaceAccessTokenReleaseResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      token: z.string().min(1).max(8_192),
      workspace: z.object({ uuid: z.string().min(1), slug: z.string().min(1) }).strict(),
    })
    .strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
]);

export type BitbucketWorkspaceAccessTokenReleaseResult = z.infer<
  typeof BitbucketWorkspaceAccessTokenReleaseResultSchema
>;

async function readBoundedReleaseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('invalid_response');
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('invalid_response');
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength &&
    (!/^[0-9]+$/.test(contentLength) ||
      Number(contentLength) > BITBUCKET_WORKSPACE_ACCESS_TOKEN_RESPONSE_MAX_BYTES)
  ) {
    throw new Error('invalid_response');
  }
  const text = await response.text();
  if (text.length > BITBUCKET_WORKSPACE_ACCESS_TOKEN_RESPONSE_MAX_BYTES) {
    throw new Error('invalid_response');
  }
  return JSON.parse(text);
}

/**
 * Ask the git-token-service to release the workspace access token of the
 * organization integration. The service re-verifies the workspace identity
 * against its own database before releasing, so a stale integration id can
 * never release another workspace's token. Every transport or schema failure
 * degrades to `temporarily_unavailable` — the client never throws past this
 * union.
 */
export async function fetchBitbucketWorkspaceAccessToken(input: {
  userId: string;
  organizationId: string;
  integrationId: string;
  expectedWorkspace: BitbucketWorkspace;
}): Promise<BitbucketWorkspaceAccessTokenReleaseResult> {
  if (!GIT_TOKEN_SERVICE_API_URL) return { status: 'temporarily_unavailable' };

  let serviceToken: string;
  try {
    serviceToken = generateInternalServiceToken(input.userId, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
      audience: BITBUCKET_WORKSPACE_ACCESS_TOKEN_AUDIENCE,
      organizationId: input.organizationId,
    });
  } catch {
    return { status: 'temporarily_unavailable' };
  }

  let response: Response;
  try {
    response = await fetch(
      `${GIT_TOKEN_SERVICE_API_URL}${BITBUCKET_WORKSPACE_ACCESS_TOKEN_RELEASE_PATH}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({
          integrationId: input.integrationId,
          workspaceUuid: input.expectedWorkspace.uuid,
          workspaceSlug: input.expectedWorkspace.slug,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUEST_TIMEOUT_MS),
      }
    );
  } catch {
    return { status: 'temporarily_unavailable' };
  }
  if (!response.ok || response.redirected) return { status: 'temporarily_unavailable' };

  try {
    const parsed = BitbucketWorkspaceAccessTokenReleaseResultSchema.safeParse(
      await readBoundedReleaseJson(response)
    );
    if (!parsed.success) return { status: 'temporarily_unavailable' };
    // A released token is only usable for the workspace it was requested
    // for: refuse a workspace identity that does not match the integration.
    if (parsed.data.status === 'available') {
      const released = parsed.data;
      if (
        released.workspace.uuid !== input.expectedWorkspace.uuid ||
        released.workspace.slug !== input.expectedWorkspace.slug
      ) {
        return { status: 'reconnect_required' };
      }
    }
    return parsed.data;
  } catch {
    return { status: 'temporarily_unavailable' };
  }
}

function releaseFailureToReviewError(status: BitbucketWorkspaceAccessTokenReleaseResult['status']) {
  switch (status) {
    case 'not_connected':
      return new BitbucketReviewError(
        'not_found',
        'The Bitbucket connection is no longer active. Reconnect Bitbucket to continue.'
      );
    case 'reconnect_required':
      return new BitbucketReviewError(
        'not_found',
        'The Bitbucket connection is no longer active. Reconnect Bitbucket to continue.'
      );
    case 'invalid_request':
      return new BitbucketReviewError('bad_request', 'Bitbucket rejected the credential request.');
    default:
      return new BitbucketReviewError(
        'retryable',
        'Bitbucket credentials are temporarily unavailable.'
      );
  }
}

const BITBUCKET_WORKSPACE_SLUG_SCHEMA = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/);

function cleanSlugSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}

/** The connected workspace identity and integration id of the org integration. */
type ResolvedWorkspaceIntegration = {
  workspace: BitbucketWorkspace;
  integrationId: string;
};

/**
 * Resolve the active organization workspace-access-token integration's
 * identity. This is the only source of the workspace UUID (`platform_account_id`)
 * and slug, and no function below accepts a workspace identity from a caller.
 */
async function resolveWorkspaceIntegration(
  owner: BitbucketReviewOwner
): Promise<ResolvedWorkspaceIntegration> {
  if (owner.type !== 'organization') {
    // Bitbucket Cloud has no personal integration: an understandable state in
    // personal context is a clear refusal, never a partial workflow.
    throw new BitbucketReviewError('not_found', BITBUCKET_ORGANIZATION_ONLY_MESSAGE);
  }

  const status = await getBitbucketWorkspaceAccessTokenStatus(owner.organizationId);
  if (status.status === 'not_connected') {
    throw new BitbucketReviewError(
      'not_found',
      'No Bitbucket connection found for this organization. Connect Bitbucket first.'
    );
  }
  if (status.status !== 'connected' || !status.workspace || !status.integrationId) {
    throw new BitbucketReviewError(
      'not_found',
      'The Bitbucket connection is no longer active. Reconnect Bitbucket to continue.'
    );
  }
  return {
    workspace: { uuid: status.workspace.uuid, slug: status.workspace.slug },
    integrationId: status.integrationId,
  };
}

/**
 * Resolve the active organization integration and release its workspace
 * access token. The inbox has no repository to verify, so it uses this
 * instead of authorizeRepository.
 */
export async function authorizeWorkspace(
  owner: BitbucketReviewOwner
): Promise<BitbucketWorkspaceAccess> {
  if (owner.type !== 'organization') {
    // Bitbucket Cloud has no personal integration: an understandable state in
    // personal context is a clear refusal, never a partial workflow.
    throw new BitbucketReviewError('not_found', BITBUCKET_ORGANIZATION_ONLY_MESSAGE);
  }
  const resolved = await resolveWorkspaceIntegration(owner);
  const accessToken = await releaseWorkspaceAccessToken({
    owner,
    workspace: resolved.workspace,
    integrationId: resolved.integrationId,
  });
  return { accessToken, workspace: resolved.workspace, owner };
}

/**
 * Verify the repository belongs to the connected workspace by matching the
 * integration's repository cache the same way the repository-cache and
 * code-review flows do (exact `workspace/repo` full name, case-insensitive).
 * A repository outside the cache is a clear not_found — the cache is the
 * authorization boundary. The workspace access token is released only after
 * the identity checks pass.
 */
export async function authorizeRepository(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string
): Promise<BitbucketRepositoryAccess> {
  const requestedWorkspace = cleanSlugSegment(workspaceSlug).toLowerCase();
  const requestedRepository = cleanSlugSegment(repoSlug).toLowerCase();
  if (
    !BITBUCKET_WORKSPACE_SLUG_SCHEMA.safeParse(requestedWorkspace).success ||
    requestedRepository.length === 0 ||
    requestedRepository.includes('/')
  ) {
    throw new BitbucketReviewError(
      'not_found',
      'The Bitbucket repository could not be found with the given identity.'
    );
  }
  if (owner.type !== 'organization') {
    throw new BitbucketReviewError('not_found', BITBUCKET_ORGANIZATION_ONLY_MESSAGE);
  }

  const resolved = await resolveWorkspaceIntegration(owner);
  // A pasted identity pointing at another workspace must never read the
  // connected workspace's repositories: refuse as not-found without revealing
  // the connected workspace.
  if (requestedWorkspace !== resolved.workspace.slug.toLowerCase()) {
    throw new BitbucketReviewError(
      'not_found',
      'This pull request is not available in your connected Bitbucket workspace.'
    );
  }

  const cache = await readCachedBitbucketWorkspaceAccessTokenRepositories({
    organizationId: owner.organizationId,
    expectedIntegrationId: resolved.integrationId,
  });
  if (cache.status === 'not_connected' || cache.status === 'reconnect_required') {
    throw new BitbucketReviewError(
      'not_found',
      'The Bitbucket connection is no longer active. Reconnect Bitbucket to continue.'
    );
  }
  if (cache.status === 'invalid_request') {
    throw new BitbucketReviewError('bad_request', 'Bitbucket rejected the repository request.');
  }
  // A permanent token-scope failure: the connected integration cannot list the
  // workspace's repositories, so no retry helps. Name the remedy instead of
  // folding it into a generic "try again" (the retryable fallback below).
  if (cache.status === 'insufficient_permissions') {
    throw new BitbucketReviewError(
      'forbidden',
      'The Bitbucket connection is missing the repository scope. Reconnect Bitbucket with repository read access to continue.'
    );
  }
  if (cache.status !== 'available') {
    throw new BitbucketReviewError(
      'retryable',
      'The Bitbucket repository list is temporarily unavailable. Try again.'
    );
  }

  const requestedFullName = `${requestedWorkspace}/${requestedRepository}`;
  const match = cache.repositories.find(
    repository => repository.fullName.toLowerCase() === requestedFullName
  );
  if (!match) {
    throw new BitbucketReviewError(
      'not_found',
      'This repository is not part of your connected Bitbucket workspace.'
    );
  }
  const matchRepository = match.fullName.split('/')[1];

  const accessToken = await releaseWorkspaceAccessToken({
    owner,
    workspace: resolved.workspace,
    integrationId: resolved.integrationId,
  });
  return {
    accessToken,
    workspace: resolved.workspace,
    repository: {
      uuid: match.id,
      slug: matchRepository ?? requestedRepository,
      fullName: match.fullName,
    },
    owner,
  };
}

async function releaseWorkspaceAccessToken(input: {
  owner: BitbucketReviewOwner & { type: 'organization' };
  workspace: BitbucketWorkspace;
  integrationId: string;
}): Promise<string> {
  const released = await fetchBitbucketWorkspaceAccessToken({
    userId: input.owner.userId,
    organizationId: input.owner.organizationId,
    integrationId: input.integrationId,
    expectedWorkspace: input.workspace,
  });
  if (released.status !== 'available') {
    throw releaseFailureToReviewError(released.status);
  }
  return released.token;
}
