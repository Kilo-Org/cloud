/**
 * Provider branch listing for the new-session flow.
 *
 * One entry point per repository identity, three providers: GitHub via
 * `githubAppsService.listBranches`, GitLab via
 * `gitlabService.listGitLabBranches`, Bitbucket Cloud via the s3 review
 * layer's authorized requests (`/refs/branches` + the repository object's
 * `mainbranch`). The
 * server resolves the integration and the credentials itself — no caller
 * supplies an integration id, a token, or a host, and the repository
 * identity is re-checked against the integration's own cache on every call.
 *
 * Bitbucket Cloud is organization-context only: a personal call returns the
 * explicit org-only unavailable state (FORBIDDEN with the shared copy from
 * the authorization layer), never an empty success.
 */
import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';

import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import type { Owner } from '@/lib/integrations/core/types';
import {
  getIntegrationForOwner,
  getIntegrationsByOrganization,
} from '@/lib/integrations/db/platform-integrations';
import * as githubAppsService from '@/lib/integrations/github-apps-service';
import * as gitlabService from '@/lib/integrations/gitlab-service';
import {
  authorizeRepository,
  BITBUCKET_ORGANIZATION_ONLY_MESSAGE,
  BitbucketReviewError,
  type BitbucketRepositoryAccess,
} from '@/lib/provider-review/bitbucket-authorization';
import {
  fetchPage,
  repositoryPathGuard,
  requestBitbucketJson,
} from '@/lib/provider-review/bitbucket-read';

export type ProviderBranchPlatform = 'github' | 'gitlab' | 'bitbucket';

export type ProviderBranchListing = {
  /** The provider's default branch, or null when the provider reports none. */
  defaultBranch: string | null;
  branches: string[];
};

/** The router output contract: `{ defaultBranch, branches }`, nothing else. */
export const ProviderBranchListingSchema = z
  .object({
    defaultBranch: z.string().nullable(),
    branches: z.array(z.string()),
  })
  .strict();

/**
 * `owner/repo`, `group/sub/project`, or `workspace/slug` — a path with at
 * least one separator, bounded like the review router's project paths.
 */
export const repositoryFullNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/)
  .max(1024);

/** The two connection refusals, shared so every provider path words them alike. */
const missingConnectionMessage = (label: string) =>
  `No ${label} connection found for this account. Connect ${label} first.`;
const inactiveConnectionMessage = (label: string) =>
  `The ${label} connection is no longer active. Reconnect ${label} to continue.`;

/** The active integration row of one owner and platform, or a clear refusal. */
async function requireActiveIntegration(owner: Owner, platform: string, label: string) {
  const integration = await getIntegrationForOwner(owner, platform);
  if (!integration) {
    throw new TRPCError({ code: 'NOT_FOUND', message: missingConnectionMessage(label) });
  }
  if (integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
    throw new TRPCError({ code: 'NOT_FOUND', message: inactiveConnectionMessage(label) });
  }
  return integration;
}

/**
 * Map a classified Bitbucket refusal onto the router error states. The
 * message is the authorization layer's fixed copy — it never embeds a token
 * or a workspace identity.
 */
function bitbucketErrorToTrpcError(error: BitbucketReviewError): TRPCError {
  switch (error.kind) {
    case 'not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: error.message });
    case 'forbidden':
      return new TRPCError({ code: 'FORBIDDEN', message: error.message });
    case 'bad_request':
      return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    default:
      // stale_head cannot come from a read; retryable surfaces as a
      // retryable gateway failure, never as an empty branch list.
      return new TRPCError({ code: 'BAD_GATEWAY', message: error.message });
  }
}

type GitHubBranchRef = { name: string; isDefault: boolean };

function toListing(branches: GitHubBranchRef[]): ProviderBranchListing {
  return {
    defaultBranch: branches.find(branch => branch.isDefault)?.name ?? null,
    branches: branches.map(branch => branch.name),
  };
}

type GitHubIntegrationRow = Awaited<ReturnType<typeof getIntegrationsByOrganization>>[number];

/** Does this installation's repository cache list the repository? GitHub paths are case-insensitive. */
function cachesRepository(integration: GitHubIntegrationRow, repositoryFullName: string): boolean {
  const wanted = repositoryFullName.toLowerCase();
  return (integration.repositories ?? []).some(
    repository => repository.full_name?.toLowerCase() === wanted
  );
}

/** A refusal meaning "this installation cannot see that repository" — try the next one. */
function isRepositoryUnreachable(error: unknown): boolean {
  if (error instanceof TRPCError) return error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN';
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
}

/**
 * An organization can hold several GitHub installations, one per GitHub
 * account it connected. The primary (oldest healthy) row only sees its own
 * repositories, so the installation is resolved from the REPOSITORY: the one
 * whose repository cache lists it goes first, then the remaining healthy rows,
 * so a stale cache cannot hide a repository an installation can really see.
 * The caller still supplies no integration id — every candidate is an
 * organization-owned row, and `listBranches` re-checks that ownership.
 */
async function listOrganizationGitHubBranches(
  owner: Owner,
  organizationId: string,
  repositoryFullName: string
): Promise<ProviderBranchListing> {
  const integrations = await getIntegrationsByOrganization(organizationId, PLATFORM.GITHUB);
  const healthy = integrations.filter(isPlatformIntegrationHealthy);
  if (healthy.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: integrations.length
        ? inactiveConnectionMessage('GitHub')
        : missingConnectionMessage('GitHub'),
    });
  }

  const candidates = [
    ...healthy.filter(integration => cachesRepository(integration, repositoryFullName)),
    ...healthy.filter(integration => !cachesRepository(integration, repositoryFullName)),
  ];
  let lastError: unknown;
  for (const integration of candidates) {
    try {
      const { branches } = await githubAppsService.listBranches(
        owner,
        integration.id,
        repositoryFullName
      );
      return toListing(branches);
    } catch (error) {
      if (!isRepositoryUnreachable(error)) throw error;
      lastError = error;
    }
  }
  throw new TRPCError({
    code: 'NOT_FOUND',
    message:
      'This repository is not available in any connected GitHub installation. Install the GitHub App on the account that owns it.',
    cause: lastError,
  });
}

async function listGitHubBranches(
  owner: Owner,
  repositoryFullName: string
): Promise<ProviderBranchListing> {
  if (owner.type === 'org') {
    return listOrganizationGitHubBranches(owner, owner.id, repositoryFullName);
  }
  const integration = await requireActiveIntegration(owner, PLATFORM.GITHUB, 'GitHub');
  const { branches } = await githubAppsService.listBranches(
    owner,
    integration.id,
    repositoryFullName
  );
  return toListing(branches);
}

async function listGitLabBranches(
  owner: Owner,
  actor: { userId: string; organizationId?: string },
  repositoryFullName: string
): Promise<ProviderBranchListing> {
  const integration = await requireActiveIntegration(owner, PLATFORM.GITLAB, 'GitLab');
  const { branches } = await gitlabService.listGitLabBranches(
    owner,
    integration.id,
    actor,
    repositoryFullName
  );
  return toListing(branches);
}

/**
 * The repository-metadata response: `GET /2.0/repositories/{ws}/{slug}`
 * returns the repository object, whose `mainbranch` is the default branch.
 * Bitbucket Cloud has no `/branch-model` endpoint — every other Bitbucket
 * adapter here (bitbucket-api.ts, workspace-access-token-adapter.ts) takes
 * the default branch from `mainbranch.name`.
 */
const BitbucketRepositoryMetadataSchema = z
  .object({
    mainbranch: z
      .object({ name: z.string().min(1) })
      .nullable()
      .optional(),
  })
  .passthrough();

const BitbucketBranchRefSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().optional(),
  })
  .passthrough();

/** Bound the page follow: a workspace with more branches than this is pathological. */
const MAX_BRANCH_PAGES = 20;

function repositoryApiPath(access: BitbucketRepositoryAccess): string {
  return `/2.0/repositories/${encodeURIComponent(access.workspace.slug)}/${encodeURIComponent(access.repository.slug)}`;
}

async function listBitbucketBranches(
  input: { userId: string; organizationId?: string },
  repositoryFullName: string
): Promise<ProviderBranchListing> {
  if (!input.organizationId) {
    // Explicit org-only unavailable state — never an empty success. The copy
    // is the shared constant from the authorization layer, so the review
    // surface and the branch listing refuse in the same words.
    throw new TRPCError({ code: 'FORBIDDEN', message: BITBUCKET_ORGANIZATION_ONLY_MESSAGE });
  }
  const separator = repositoryFullName.indexOf('/');
  const workspace = repositoryFullName.slice(0, separator);
  const repoSlug = repositoryFullName.slice(separator + 1);
  if (separator < 1 || repoSlug.length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The Bitbucket repository must be named "workspace/repository".',
    });
  }

  let access: BitbucketRepositoryAccess;
  try {
    // authorizeRepository re-derives the connected workspace identity from
    // the integration and verifies the repository against its cache — a
    // client cannot steer it to another workspace.
    access = await authorizeRepository(
      { type: 'organization', organizationId: input.organizationId, userId: input.userId },
      workspace,
      repoSlug
    );
  } catch (error) {
    if (error instanceof BitbucketReviewError) throw bitbucketErrorToTrpcError(error);
    throw error;
  }

  let defaultBranch: string | null = null;
  try {
    const metadata = BitbucketRepositoryMetadataSchema.safeParse(
      await requestBitbucketJson<unknown>(access, repositoryApiPath(access))
    );
    defaultBranch = metadata.success ? (metadata.data.mainbranch?.name ?? null) : null;
  } catch {
    // A repository-metadata read failure must not blank the branch list; the
    // session flow works without a preselected default.
  }

  const names: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_BRANCH_PAGES; page += 1) {
      const result = await fetchPage(
        access,
        `${repositoryApiPath(access)}/refs/branches`,
        `bitbucket-branches:${access.repository.fullName}`,
        cursor,
        repositoryPathGuard(access)
      );
      for (const value of result.values) {
        const parsed = BitbucketBranchRefSchema.safeParse(value);
        if (!parsed.success) continue;
        if (parsed.data.type !== undefined && parsed.data.type !== 'branch') continue;
        if (seen.has(parsed.data.name)) continue;
        seen.add(parsed.data.name);
        names.push(parsed.data.name);
      }
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
  } catch (error) {
    if (error instanceof BitbucketReviewError) throw bitbucketErrorToTrpcError(error);
    throw error;
  }

  return { defaultBranch, branches: names };
}

/**
 * List the branches of one repository on one provider. The owner identity
 * comes from the caller's context (the router passes `ctx.user.id` plus a
 * guard-checked organizationId); the integration, token, and repository
 * identity are re-derived here on every call.
 */
export async function listProviderRepositoryBranches(input: {
  platform: ProviderBranchPlatform;
  userId: string;
  organizationId?: string;
  repositoryFullName: string;
}): Promise<ProviderBranchListing> {
  const owner: Owner = input.organizationId
    ? { type: 'org', id: input.organizationId }
    : { type: 'user', id: input.userId };
  const actor = {
    userId: input.userId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  };
  switch (input.platform) {
    case 'github':
      return listGitHubBranches(owner, input.repositoryFullName);
    case 'gitlab':
      return listGitLabBranches(owner, actor, input.repositoryFullName);
    case 'bitbucket':
      return listBitbucketBranches(input, input.repositoryFullName);
  }
}
