import 'server-only';

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  CodeReviewCouncilConfigSchema,
  MAX_RUNTIME_AGENT_MODEL_LENGTH,
  type CodeReviewType,
  type ManualCodeReviewConfig,
} from '@kilocode/db/schema-types';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import {
  CodeReviewAgentConfigSchema,
  type CodeReviewAgentConfig,
} from '@/lib/agent-config/core/types';
import {
  COUNCIL_MIN_SPECIALISTS,
  enabledSpecialists,
  isCouncilActive,
} from '@kilocode/worker-utils/code-review-council';
import { assertCouncilCreationAllowed } from './core/council-entitlement';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { isLocalCodeReviewDevelopmentEnabled } from '@/lib/config.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getGitHubPullRequestCheckoutRef } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-checkout-ref';
import { getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { fetchGitLabMergeRequest } from '@/lib/integrations/platforms/gitlab/adapter';
import { normalizeGitLabInstanceUrl } from '@/lib/integrations/platforms/gitlab/instance-url';
import type { CodeReviewPlatform, Owner } from './core';
import { createCodeReview, findActiveProviderPublishingReview } from './db/code-reviews';
import { tryDispatchPendingReviews } from './dispatch/dispatch-pending-reviews';
import { logExceptInTest } from '@/lib/utils.server';

const MANUAL_REVIEW_REQUEST_TIMEOUT_MS = 10_000;

export const ManualCodeReviewJobInputSchema = z.object({
  platform: z.enum(['github', 'gitlab']),
  url: z.string().url(),
  modelSlug: z.string().min(1).max(512),
  thinkingEffort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
  instructions: z.string().max(4_000).optional(),
  // When present, this is a multi-specialist council run. The specialists (with their
  // per-specialist model/effort) and aggregation strategy are carried here and merged
  // into the run's agent config. Absent = a standard single-reviewer run.
  council: CodeReviewCouncilConfigSchema.optional(),
});

export type ManualCodeReviewJobInput = z.infer<typeof ManualCodeReviewJobInputSchema>;

export type CreateManualCodeReviewJobResult = {
  reviewId: string;
  outputMode: ManualCodeReviewConfig['outputMode'];
};

type ParsedGitHubPullRequestUrl = {
  owner: string;
  repo: string;
  prNumber: number;
};

type ParsedGitLabMergeRequestUrl = {
  origin: string;
  projectPath: string;
  mrIid: number;
};

type ResolvedManualReviewSource = {
  platform: CodeReviewPlatform;
  integrationId?: string;
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prAuthor: string;
  prAuthorGithubId?: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  platformProjectId?: number;
};

type GitHubPullRequestFetchResult =
  | {
      status: 'ok';
      pullRequest: GitHubPullRequestApi;
    }
  | {
      status: 'inaccessible';
    }
  | {
      status: 'error';
      message: string;
    };

const GitHubPullRequestApiSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  user: z.object({
    login: z.string(),
    id: z.union([z.string(), z.number()]).optional(),
  }),
  base: z.object({
    ref: z.string(),
    repo: z.object({
      full_name: z.string(),
    }),
  }),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
  }),
});

type GitHubPullRequestApi = z.infer<typeof GitHubPullRequestApiSchema>;

const GitLabMergeRequestApiSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string(),
  web_url: z.string().url(),
  author: z.object({
    username: z.string(),
  }),
  target_project_id: z.number().int().positive().optional(),
  project_id: z.number().int().positive().optional(),
});

type GitLabMergeRequestApi = z.infer<typeof GitLabMergeRequestApiSchema>;

const defaultCodeReviewAgentConfig: CodeReviewAgentConfig = {
  review_style: 'balanced',
  focus_areas: [],
  custom_instructions: null,
  model_slug: PRIMARY_DEFAULT_MODEL,
  thinking_effort: null,
  gate_threshold: 'off',
  repository_selection_mode: 'all',
  selected_repository_ids: [],
  manually_added_repositories: [],
  disable_review_md: true,
  review_memory_enabled: false,
  review_analytics_enabled: false,
};

export async function createManualCodeReviewJob(params: {
  owner: Owner;
  input: ManualCodeReviewJobInput;
}): Promise<CreateManualCodeReviewJobResult> {
  const input = ManualCodeReviewJobInputSchema.parse(params.input);
  const platform = input.platform;
  const localMode = isLocalCodeReviewDevelopmentEnabled();
  const instructions = normalizeManualInstructions(input.instructions);

  // Reject an enabled council that is under the specialist minimum, so a request can't be
  // stamped/charged as a council yet be unable to behave as one. (`council: {}` parses to
  // an enabled council with zero specialists.)
  if (
    input.council?.enabled &&
    enabledSpecialists(input.council).length < COUNCIL_MIN_SPECIALISTS
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `A council review requires at least ${COUNCIL_MIN_SPECIALISTS} specialists.`,
    });
  }

  // Derive the run type from the canonical predicate, not mere presence — a disabled or
  // empty council is a standard run. This keeps review_type, the entitlement charge, and
  // actual council behavior (isCouncilActive) in agreement.
  const councilActive = isCouncilActive(input.council);
  const reviewType: CodeReviewType = councilActive ? 'council' : 'standard';

  // A council specialist without its own model inherits the review's base model into
  // `runtimeAgents[].model`, which cloud-agent-next caps at MAX_RUNTIME_AGENT_MODEL_LENGTH.
  // Per-specialist models are already bounded by the schema; bound the inherited base too so
  // a council request accepted here cannot fail later at session preparation. (Only matters
  // when some enabled specialist actually inherits the base — an unrealistic length, but a
  // cheap parity guard against the wider `modelSlug` bound.)
  if (councilActive && input.council) {
    const baseModel = input.modelSlug ?? '';
    const someInheritsBase = enabledSpecialists(input.council).some(s => !s.model_slug);
    if (someInheritsBase && baseModel.length > MAX_RUNTIME_AGENT_MODEL_LENGTH) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `The review model slug is too long for a council run (max ${MAX_RUNTIME_AGENT_MODEL_LENGTH} characters).`,
      });
    }
  }

  // Council uses the exact same flow as a standard manual review — the only difference is
  // running specialists. Output mode is therefore identical for both: `kilo` in local dev
  // (public repos, no PR posting) and `provider` in prod (authenticated clone incl. private
  // repos, posts to the PR). No council-specific publish handling.
  const outputMode: ManualCodeReviewConfig['outputMode'] = localMode ? 'kilo' : 'provider';

  // Fail fast on entitlement before doing any provider/network work. The creation
  // boundary (`createCodeReview`) re-checks this as the authoritative gate, so this repeats
  // the entitlement lookup on the (rare, interactive, enterprise-only) council path. That
  // redundancy is intentional: we prefer it over threading a "already authorized" bypass
  // flag into `createCodeReview`, which would weaken the single security boundary.
  await assertCouncilCreationAllowed({ owner: params.owner, reviewType });

  const agentConfig = await buildManualAgentConfig({
    owner: params.owner,
    platform,
    modelSlug: input.modelSlug,
    thinkingEffort: input.thinkingEffort ?? null,
    // Only persist the council config for an actual council run; a standard run clears it.
    council: councilActive ? (input.council ?? null) : null,
  });

  const source = localMode
    ? await resolveLocalPublicSource(platform, input.url)
    : await resolveConnectedProviderSource(params.owner, platform, input.url);

  if (outputMode === 'provider') {
    if (!source.integrationId) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Connect the selected provider before starting a manual Code Reviewer job.',
      });
    }

    const activePublisher = await findActiveProviderPublishingReview({
      platformIntegrationId: source.integrationId,
      repoFullName: source.repoFullName,
      prNumber: source.prNumber,
    });
    if (activePublisher) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A provider-publishing Code Reviewer job is already active for this change.',
      });
    }
  }

  const manualConfig: ManualCodeReviewConfig = {
    agentConfig,
    instructions,
    outputMode,
  };

  try {
    const reviewId = await createCodeReview({
      owner: params.owner,
      platformIntegrationId: source.integrationId,
      repoFullName: source.repoFullName,
      prNumber: source.prNumber,
      prUrl: source.prUrl,
      prTitle: source.prTitle,
      prAuthor: source.prAuthor,
      prAuthorGithubId: source.prAuthorGithubId,
      baseRef: source.baseRef,
      headRef: source.headRef,
      headSha: source.headSha,
      platform: source.platform,
      platformProjectId: source.platformProjectId,
      manualConfig,
      reviewType,
      triggerSource: 'manual',
    });

    logExceptInTest('[manual-code-review-job] Created manual Code Reviewer job', {
      reviewId,
      owner: params.owner,
      platform,
      outputMode,
    });
    await tryDispatchPendingReviews(params.owner);
    return { reviewId, outputMode };
  } catch (error) {
    if (
      getDatabaseErrorCode(error) === '23505' &&
      outputMode === 'provider' &&
      source.integrationId
    ) {
      const activePublisher = await findActiveProviderPublishingReview({
        platformIntegrationId: source.integrationId,
        repoFullName: source.repoFullName,
        prNumber: source.prNumber,
      });
      if (activePublisher) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A provider-publishing Code Reviewer job is already active for this change.',
        });
      }
    }
    throw error;
  }
}

function normalizeManualInstructions(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

async function buildManualAgentConfig(params: {
  owner: Owner;
  platform: CodeReviewPlatform;
  modelSlug: string;
  thinkingEffort: string | null;
  council: CodeReviewAgentConfig['council'] | null;
}): Promise<CodeReviewAgentConfig> {
  const savedConfig = await getAgentConfigForOwner(params.owner, 'code_review', params.platform);
  const parsedSavedConfig = savedConfig
    ? CodeReviewAgentConfigSchema.safeParse(savedConfig.config)
    : null;
  const baseConfig = parsedSavedConfig?.success
    ? parsedSavedConfig.data
    : defaultCodeReviewAgentConfig;

  return {
    ...baseConfig,
    model_slug: params.modelSlug,
    thinking_effort: params.thinkingEffort,
    // Manual runs carry their council selection in the run's agent config; a standard
    // run clears any inherited council so it can't accidentally run as a council.
    council: params.council ?? undefined,
  };
}

async function resolveConnectedProviderSource(
  owner: Owner,
  platform: CodeReviewPlatform,
  url: string
): Promise<ResolvedManualReviewSource> {
  if (platform === PLATFORM.GITHUB) {
    return await resolveConnectedGitHubSource(owner, url);
  }

  return await resolveConnectedGitLabSource(owner, url);
}

async function resolveLocalPublicSource(
  platform: CodeReviewPlatform,
  url: string
): Promise<ResolvedManualReviewSource> {
  if (platform === PLATFORM.GITHUB) {
    const parsed = parseGitHubPullRequestUrl(url);
    const pullRequest = await fetchPublicGitHubPullRequest(parsed);
    validateOpenGitHubPullRequest(pullRequest);
    return buildGitHubSource(pullRequest, undefined);
  }

  const parsed = parseGitLabMergeRequestUrl(url);
  if (new URL(parsed.origin).hostname !== 'gitlab.com') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Local Code Reviewer jobs only support public gitlab.com merge requests.',
    });
  }

  const mergeRequest = await fetchPublicGitLabMergeRequest(parsed);
  validateOpenGitLabMergeRequest(mergeRequest);
  return buildGitLabSource({
    mergeRequest,
    projectPath: parsed.projectPath,
    integrationId: undefined,
    platformProjectId: mergeRequest.target_project_id ?? mergeRequest.project_id,
  });
}

async function resolveConnectedGitHubSource(
  owner: Owner,
  url: string
): Promise<ResolvedManualReviewSource> {
  const parsed = parseGitHubPullRequestUrl(url);
  const integrations = (await getAllIntegrationsForOwner(owner)).filter(
    integration =>
      integration.platform === PLATFORM.GITHUB && integration.integration_status === 'active'
  );

  if (integrations.length === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Connect GitHub before starting a manual Code Reviewer job.',
    });
  }

  let sawReadOnlyIntegration = false;
  const errors: string[] = [];
  for (const integration of integrations) {
    if (integration.github_app_type === 'lite') {
      sawReadOnlyIntegration = true;
      continue;
    }
    if (!integration.platform_installation_id || integration.suspended_at) continue;

    const appType = integration.github_app_type ?? 'standard';
    const tokenData = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      appType
    );
    const result = await fetchGitHubPullRequest(parsed, tokenData.token);
    if (result.status === 'ok') {
      validateOpenGitHubPullRequest(result.pullRequest);
      return buildGitHubSource(result.pullRequest, integration.id);
    }
    if (result.status === 'error') {
      errors.push(result.message);
    }
  }

  if (
    sawReadOnlyIntegration &&
    integrations.every(integration => integration.github_app_type === 'lite')
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'GitHub Lite is read-only. Connect the standard GitHub App to publish manual Code Reviewer findings.',
    });
  }

  throw new TRPCError({
    code: 'NOT_FOUND',
    message: errors[0] ?? 'No connected GitHub installation can read this pull request.',
  });
}

async function resolveConnectedGitLabSource(
  owner: Owner,
  url: string
): Promise<ResolvedManualReviewSource> {
  const parsed = parseGitLabMergeRequestUrl(url);
  const integrations = (await getAllIntegrationsForOwner(owner)).filter(
    integration =>
      integration.platform === PLATFORM.GITLAB && integration.integration_status === 'active'
  );

  if (integrations.length === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Connect GitLab before starting a manual Code Reviewer job.',
    });
  }

  for (const integration of integrations) {
    const instanceUrl = getGitLabIntegrationInstanceUrl(integration);
    if (parsed.origin !== instanceUrl) continue;

    const accessToken = await getValidGitLabToken(integration);
    const rawMergeRequest = await fetchGitLabMergeRequest({
      accessToken,
      projectId: parsed.projectPath,
      mrIid: parsed.mrIid,
      instanceUrl,
    });
    const mergeRequest = GitLabMergeRequestApiSchema.parse(rawMergeRequest);
    validateOpenGitLabMergeRequest(mergeRequest);

    return buildGitLabSource({
      mergeRequest,
      projectPath: parsed.projectPath,
      integrationId: integration.id,
      platformProjectId:
        mergeRequest.target_project_id ??
        mergeRequest.project_id ??
        getGitLabRepositoryIdFromIntegration(integration, parsed.projectPath),
    });
  }

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'The merge request URL does not match a connected GitLab instance.',
  });
}

function buildGitHubSource(
  pullRequest: GitHubPullRequestApi,
  integrationId: string | undefined
): ResolvedManualReviewSource {
  return {
    platform: PLATFORM.GITHUB,
    integrationId,
    repoFullName: pullRequest.base.repo.full_name,
    prNumber: pullRequest.number,
    prUrl: pullRequest.html_url,
    prTitle: pullRequest.title,
    prAuthor: pullRequest.user.login,
    prAuthorGithubId: pullRequest.user.id === undefined ? undefined : String(pullRequest.user.id),
    baseRef: pullRequest.base.ref,
    headRef: getGitHubPullRequestCheckoutRef(pullRequest.number),
    headSha: pullRequest.head.sha,
  };
}

function buildGitLabSource(params: {
  mergeRequest: GitLabMergeRequestApi;
  projectPath: string;
  integrationId: string | undefined;
  platformProjectId: number | undefined;
}): ResolvedManualReviewSource {
  return {
    platform: PLATFORM.GITLAB,
    integrationId: params.integrationId,
    repoFullName: params.projectPath,
    prNumber: params.mergeRequest.iid,
    prUrl: params.mergeRequest.web_url,
    prTitle: params.mergeRequest.title,
    prAuthor: params.mergeRequest.author.username,
    baseRef: params.mergeRequest.target_branch,
    headRef: `refs/merge-requests/${params.mergeRequest.iid}/head`,
    headSha: params.mergeRequest.sha,
    platformProjectId: params.platformProjectId,
  };
}

function parseGitHubPullRequestUrl(url: string): ParsedGitHubPullRequestUrl {
  const parsed = parseHttpsUrl(url);
  if (parsed.hostname !== 'github.com') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Enter a canonical github.com pull request URL.',
    });
  }

  const segments = pathSegments(parsed);
  if (segments.length !== 4 || segments[2] !== 'pull') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Enter a GitHub URL like https://github.com/owner/repo/pull/123.',
    });
  }

  return {
    owner: segments[0],
    repo: segments[1],
    prNumber: parsePositiveInteger(segments[3], 'pull request number'),
  };
}

function parseGitLabMergeRequestUrl(url: string): ParsedGitLabMergeRequestUrl {
  const parsed = parseHttpsUrl(url);
  const segments = pathSegments(parsed);
  const markerIndex = segments.findIndex(segment => segment === '-');
  if (
    markerIndex < 1 ||
    segments[markerIndex + 1] !== 'merge_requests' ||
    markerIndex + 3 !== segments.length
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Enter a GitLab URL like https://gitlab.com/group/project/-/merge_requests/123.',
    });
  }

  return {
    origin: parsed.origin,
    projectPath: segments.slice(0, markerIndex).join('/'),
    mrIid: parsePositiveInteger(segments[markerIndex + 2], 'merge request IID'),
  };
}

function parseHttpsUrl(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Enter an HTTPS pull request or merge request URL.',
    });
  }
  return parsed;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(segment => segment.length > 0);
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid ${label}.` });
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid ${label}.` });
  }
  return parsed;
}

async function fetchPublicGitHubPullRequest(
  parsed: ParsedGitHubPullRequestUrl
): Promise<GitHubPullRequestApi> {
  const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.prNumber}`;
  const data = await fetchJson(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  return GitHubPullRequestApiSchema.parse(data);
}

async function fetchGitHubPullRequest(
  parsed: ParsedGitHubPullRequestUrl,
  token: string
): Promise<GitHubPullRequestFetchResult> {
  const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.prNumber}`;
  try {
    const data = await fetchJson(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
    });
    return { status: 'ok', pullRequest: GitHubPullRequestApiSchema.parse(data) };
  } catch (error) {
    if (error instanceof ProviderFetchError && (error.status === 403 || error.status === 404)) {
      return { status: 'inaccessible' };
    }
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchPublicGitLabMergeRequest(
  parsed: ParsedGitLabMergeRequestUrl
): Promise<GitLabMergeRequestApi> {
  const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests/${parsed.mrIid}`;
  const data = await fetchJson(url, { headers: { Accept: 'application/json' } });
  return GitLabMergeRequestApiSchema.parse(data);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(MANUAL_REVIEW_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ProviderFetchError(response.status, await response.text());
  }

  return await response.json();
}

function validateOpenGitHubPullRequest(pullRequest: GitHubPullRequestApi): void {
  if (pullRequest.state !== 'open') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Code Reviewer can only start manual jobs for open pull requests.',
    });
  }
  if (pullRequest.draft === true) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Code Reviewer does not run on draft pull requests.',
    });
  }
}

function validateOpenGitLabMergeRequest(mergeRequest: GitLabMergeRequestApi): void {
  if (mergeRequest.state !== 'opened') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Code Reviewer can only start manual jobs for open merge requests.',
    });
  }
  if (mergeRequest.draft === true || mergeRequest.work_in_progress === true) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Code Reviewer does not run on draft merge requests.',
    });
  }
}

function getGitLabIntegrationInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata;
  const instanceUrl =
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    'gitlab_instance_url' in metadata
      ? metadata.gitlab_instance_url
      : undefined;
  return normalizeGitLabInstanceUrl(typeof instanceUrl === 'string' ? instanceUrl : undefined);
}

function getGitLabRepositoryIdFromIntegration(
  integration: PlatformIntegration,
  projectPath: string
): number | undefined {
  const repositories = integration.repositories;
  const repository = repositories?.find(candidate => candidate.full_name === projectPath);
  return typeof repository?.id === 'number' ? repository.id : undefined;
}

function getDatabaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : null;
}

class ProviderFetchError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Provider request failed with ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'ProviderFetchError';
    this.status = status;
  }
}
