/**
 * Prepare Code Review Payload
 *
 * Extracts all preparation logic (DB lookups, token generation, prompt generation)
 * Returns complete payload ready for cloud agent
 *
 * Supports GitHub, GitLab, and Bitbucket platforms.
 */

import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { generateApiToken } from '@/lib/tokens';
import {
  generateGitHubInstallationToken,
  findKiloReviewComment,
  fetchPRInlineComments,
  getPRHeadCommit,
  fetchGitHubRootTextFileAtRef,
  fetchGitHubRepositorySize,
} from '@/lib/integrations/platforms/github/adapter';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import type {
  ReviewAgentSelection,
  ReviewAgentsConfig,
} from '@kilocode/worker-utils/review-agents';
import type { RuntimeAgentInput } from '@kilocode/worker-utils/cloud-agent-next-client';
import { enabledSpecialists, isCouncilActive } from '@kilocode/worker-utils/code-review-council';
import {
  buildCouncilOrchestratorPrompt,
  buildCouncilRuntimeAgents,
} from '@/lib/code-reviews/prompts/council-prompt';
import {
  findKiloReviewNote,
  fetchMRInlineComments,
  getMRHeadCommit,
  getMRDiffRefs,
  GitLabProjectAccessTokenPermissionError,
  fetchGitLabRootTextFileAtRef,
  fetchGitLabRepositorySize,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  getOrCreateProjectAccessToken,
  type GitLabIntegrationMetadata,
} from '@/lib/integrations/gitlab-service';
import type {
  ExistingReviewState,
  PreviousReviewStatus,
  GitLabDiffContext,
} from '../prompts/generate-prompt';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  getCodeReviewById,
  findPreviousCompletedReview,
  updatePreviousReviewSummary,
  updateRepositoryReviewInstructionsMetadata,
  type ReviewScope,
} from '../db/code-reviews';
import { DEFAULT_CODE_REVIEW_MODEL, DEFAULT_CODE_REVIEW_MODE } from '../core/constants';
import type { Owner } from '../core';
import { generateReviewPrompt } from '../prompts/generate-prompt';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { logExceptInTest, errorExceptInTest, warnExceptInTest } from '@/lib/utils.server';
import type { CodeReviewPlatform } from '../core/schemas';
import {
  normalizeRepositoryReviewInstructions,
  REVIEW_INSTRUCTIONS_FILE,
} from '../prompts/repository-review-instructions';
import { getCurrentReviewSummaryForContext } from '../summary/history';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import {
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { getGitHubPullRequestCheckoutRef } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-checkout-ref';
import { getManualCodeReviewConfig } from '../manual-config';

const BitbucketWorkspaceSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/);
const BitbucketRepositorySlugSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/);
const BitbucketHeadShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const BitbucketCachedRepositoriesSchema = z.array(
  z
    .object({
      id: z.string().uuid(),
      name: z.string().min(1),
      full_name: z.string().min(3),
      private: z.boolean(),
      default_branch: z.string().min(1).optional(),
    })
    .passthrough()
);

export type PreparePayloadParams = {
  reviewId: string;
  owner: Owner;
  agentConfig: {
    config: CodeReviewAgentConfig | Record<string, unknown>;
    [key: string]: unknown;
  };
  /** Platform type (defaults to 'github' for backward compatibility) */
  platform?: CodeReviewPlatform;
};

export type SessionInput = {
  /** GitHub repo in format "owner/repo" (for GitHub platform) */
  githubRepo?: string;
  /** Full git URL for cloning (for GitLab and other platforms) */
  gitUrl?: string;
  kilocodeOrganizationId?: string;
  prompt: string;
  mode: 'code';
  model: string;
  /** Thinking effort variant name (e.g. "high", "max") — undefined means model default */
  variant?: string;
  upstreamBranch: string;
  /** GitHub installation token (for GitHub platform) */
  githubToken?: string;
  /** Generic git token for authentication (for GitLab and other platforms) */
  gitToken?: string;
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab' | 'bitbucket';
  bitbucketWorkspaceUuid?: string;
  bitbucketWorkspaceSlug?: string;
  bitbucketRepositoryUuid?: string;
  bitbucketRepositorySlug?: string;
  bitbucketIntegrationId?: string;
  bitbucketPullRequestId?: number;
  bitbucketExpectedHeadSha?: string;
  /** Gate threshold — when not 'off', the agent should report gateResult in its callback */
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
  /** Council runs only: one inline sub-agent per specialist, each pinned to its own model. */
  runtimeAgents?: RuntimeAgentInput[];
};

/**
 * Review agent selection wire contract shared with the code-review Worker. Defined once
 * in `@kilocode/worker-utils/review-agents` so producer and consumer cannot drift as
 * council mode adds fields. See that module for the forward-plumbing notes.
 */
export type { ReviewAgentSelection, ReviewAgentsConfig };

export type CodeReviewPayload = {
  reviewId: string;
  attemptId?: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  skipBalanceCheck?: boolean;
  /** Cloud-agent session ID from a previous completed review, for session continuation */
  previousCloudAgentSessionId?: string;
  /** Provider-reported repository storage size, formatted for log correlation. */
  repositorySize?: string | null;
  /**
   * Forward-shaped review agent selections. Built for every review (standard = a single
   * `'standard'` agent). Only `agents[0]` is consumed today; the rest is plumbing for
   * council mode. Required on the producer output so no return path can silently omit
   * it; it stays optional on the Worker request and persisted state for rolling-deploy
   * and in-flight compatibility.
   */
  reviewAgents: ReviewAgentsConfig;
};

/**
 * Prepare complete payload for code review
 * Does all the heavy lifting: DB queries, token generation, prompt generation
 * Supports GitHub, GitLab, and Bitbucket platforms.
 */
export async function prepareReviewPayload(
  params: PreparePayloadParams
): Promise<CodeReviewPayload> {
  const { reviewId, owner, agentConfig, platform = 'github' } = params;

  logExceptInTest('[prepareReviewPayload] Starting payload preparation', {
    reviewId,
    platform,
    ownerType: owner.type,
    ownerId: owner.id,
  });

  try {
    // 1. Get the review from DB
    const review = await getCodeReviewById(reviewId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }

    const manualConfig = getManualCodeReviewConfig(review);
    const outputMode = manualConfig?.outputMode ?? 'provider';
    const config = manualConfig?.agentConfig ?? (agentConfig.config as CodeReviewAgentConfig);
    const shouldUseReviewMd = outputMode === 'provider' && config.disable_review_md === false;

    logExceptInTest('[prepareReviewPayload] Found review in DB', {
      reviewId,
      repoFullName: review.repo_full_name,
      prNumber: review.pr_number,
      platformIntegrationId: review.platform_integration_id,
      outputMode,
      baseRef: review.base_ref,
      headRef: review.head_ref,
    });

    // 2. Get the user by userId
    const [user] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, owner.userId))
      .limit(1);

    if (!user) {
      throw new Error(`User ${owner.userId} not found`);
    }

    switch (platform) {
      case PLATFORM.BITBUCKET: {
        if (
          owner.type !== 'org' ||
          review.owned_by_organization_id !== owner.id ||
          review.owned_by_user_id !== null
        ) {
          throw new Error('Bitbucket Code Reviewer requires exact organization ownership');
        }
        if (!review.platform_integration_id) {
          throw new Error('Bitbucket review is missing its platform integration ID');
        }

        const integration = await getIntegrationById(review.platform_integration_id, owner.id);
        if (
          !integration ||
          integration.platform !== BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM ||
          integration.integration_type !== BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE ||
          integration.integration_status !== INTEGRATION_STATUS.ACTIVE ||
          integration.auth_invalid_at !== null ||
          integration.owned_by_organization_id !== owner.id ||
          integration.owned_by_user_id !== null ||
          integration.platform_installation_id !== null
        ) {
          throw new Error(
            'Bitbucket review requires its exact active organization Workspace Access Token integration'
          );
        }

        const workspaceUuid = z.string().uuid().safeParse(integration.platform_account_id);
        const workspaceSlug = BitbucketWorkspaceSlugSchema.safeParse(
          integration.platform_account_login
        );
        if (!workspaceUuid.success || !workspaceSlug.success) {
          throw new Error('Bitbucket integration has invalid typed workspace identity');
        }
        if (
          review.platform !== PLATFORM.BITBUCKET ||
          review.platform_integration_id !== integration.id
        ) {
          throw new Error('Bitbucket review integration identity does not match its integration');
        }

        const cachedRepositories = BitbucketCachedRepositoriesSchema.safeParse(
          integration.repositories
        );
        const selectedRepositoryIds = config.selected_repository_ids ?? [];
        if (config.repository_selection_mode !== 'selected' || !cachedRepositories.success) {
          throw new Error('Bitbucket review repository is not selected from the integration cache');
        }

        const cachedRepository = cachedRepositories.data.find(
          repository => repository.full_name === review.repo_full_name
        );
        const repositoryUuid = z.string().uuid().safeParse(cachedRepository?.id);
        const repositorySegments = cachedRepository?.full_name.split('/') ?? [];
        const repositorySlug = BitbucketRepositorySlugSchema.safeParse(repositorySegments[1]);
        if (
          !cachedRepository ||
          !repositoryUuid.success ||
          !selectedRepositoryIds.includes(repositoryUuid.data) ||
          repositorySegments.length !== 2 ||
          repositorySegments[0] !== workspaceSlug.data ||
          !repositorySlug.success ||
          review.repo_full_name !== cachedRepository.full_name
        ) {
          throw new Error(
            'Bitbucket review repository identity does not match its integration cache'
          );
        }

        const expectedHeadSha = BitbucketHeadShaSchema.safeParse(review.head_sha);
        if (!expectedHeadSha.success || !review.head_ref.trim()) {
          throw new Error('Bitbucket review has invalid source branch or expected head identity');
        }

        const { prompt, version } = await generateReviewPrompt(
          config,
          cachedRepository.full_name,
          review.pr_number,
          {
            platform: PLATFORM.BITBUCKET,
            expectedHeadSha: expectedHeadSha.data,
          }
        );
        const authToken = generateApiToken(user, { botId: 'reviewer' });
        // Single source for the standard reviewer's model so the session input and the
        // forward-shaped `reviewAgents[0]` can never drift apart.
        const standardModel = config.model_slug || DEFAULT_CODE_REVIEW_MODEL;
        const sessionInput: SessionInput = {
          gitUrl: `https://bitbucket.org/${workspaceSlug.data}/${repositorySlug.data}.git`,
          kilocodeOrganizationId: owner.id,
          prompt,
          mode: DEFAULT_CODE_REVIEW_MODE as 'code',
          model: standardModel,
          variant: config.thinking_effort ?? undefined,
          upstreamBranch: review.head_ref,
          platform: PLATFORM.BITBUCKET,
          bitbucketWorkspaceUuid: workspaceUuid.data,
          bitbucketWorkspaceSlug: workspaceSlug.data,
          bitbucketRepositoryUuid: repositoryUuid.data,
          bitbucketRepositorySlug: repositorySlug.data,
          bitbucketIntegrationId: integration.id,
          bitbucketPullRequestId: review.pr_number,
          bitbucketExpectedHeadSha: expectedHeadSha.data,
        };

        // Forward-shaped agent selections, built for every review (see GitHub/GitLab
        // path below). Today this is always a single 'standard' agent mirroring the
        // session's model/effort; council mode will populate one entry per specialist.
        const reviewAgents: ReviewAgentsConfig = {
          reviewType: 'standard',
          agents: [
            {
              role: 'standard',
              model: standardModel,
              thinkingEffort: config.thinking_effort ?? null,
            },
          ],
        };

        logExceptInTest('[prepareReviewPayload] Prepared Bitbucket payload', {
          reviewId,
          version,
          organizationId: owner.id,
          integrationId: integration.id,
          workspaceUuid: workspaceUuid.data,
          repositoryUuid: repositoryUuid.data,
          pullRequestId: review.pr_number,
        });

        return {
          reviewId,
          authToken,
          sessionInput,
          owner,
          repositorySize: null,
          reviewAgents,
        };
      }
      case PLATFORM.GITHUB:
      case PLATFORM.GITLAB:
        break;
      default: {
        const exhaustivePlatform: never = platform;
        throw new Error(`Unknown Code Reviewer platform: ${exhaustivePlatform}`);
      }
    }

    // 3. Get platform token and build review state based on platform
    let githubToken: string | undefined;
    let gitlabToken: string | undefined;
    const reviewScope: ReviewScope = {
      owner,
      platform,
      repoFullName: review.repo_full_name,
      prNumber: review.pr_number,
    };
    let gitlabInstanceUrl: string | undefined;
    let existingReviewState: ExistingReviewState | null = null;
    let gitlabContext: GitLabDiffContext | undefined;
    let repositoryReviewInstructionsLookup = unusedRepositoryReviewInstructionsLookup();
    let repositorySize: string | null = null;

    if (outputMode === 'provider') {
      if (!review.platform_integration_id) {
        throw new Error(`Provider Code Reviewer job ${reviewId} is missing its integration`);
      }

      const integration = await getIntegrationById(review.platform_integration_id);

      if (!integration) {
        throw new Error(`Provider Code Reviewer job ${reviewId} integration is unavailable`);
      }

      if (platform === 'github' && integration?.platform_installation_id) {
        const installationId = integration.platform_installation_id;
        // Use the stored app type (defaults to 'standard' for existing integrations)
        const appType: GitHubAppType = integration.github_app_type || 'standard';
        // GitHub: Use installation token. Auth failures here (e.g. IP allow list
        // blocking, suspended/uninstalled app) are hard failures: without a token
        // we cannot clone private repos or post review comments. Let the error
        // propagate so the user sees a meaningful failure on the review.
        const tokenData = await generateGitHubInstallationToken(installationId, appType);
        const installationToken = tokenData.token;
        githubToken = installationToken;
        const [repoOwner, repoName] = review.repo_full_name.split('/');

        try {
          repositorySize = await fetchGitHubRepositorySize({
            token: installationToken,
            owner: repoOwner,
            repo: repoName,
          });
          logExceptInTest('[prepareReviewPayload] Repository size lookup complete', {
            platform,
            repoFullName: review.repo_full_name,
            repositorySize,
            repositorySizeKnown: repositorySize !== null,
          });
        } catch (error) {
          warnExceptInTest('[prepareReviewPayload] Repository size lookup failed; continuing', {
            platform,
            repoFullName: review.repo_full_name,
            error: getReviewInstructionsFetchErrorMetadata(error),
          });
        }

        const repositoryReviewInstructionsPromise =
          shouldUseReviewMd && repoOwner && repoName
            ? fetchRepositoryReviewInstructions({
                platform,
                repoFullName: review.repo_full_name,
                baseRef: review.base_ref,
                fetchInstructions: () =>
                  fetchGitHubRootTextFileAtRef({
                    token: installationToken,
                    owner: repoOwner,
                    repo: repoName,
                    path: REVIEW_INSTRUCTIONS_FILE,
                    ref: review.base_ref,
                  }),
              })
            : undefined;

        if (shouldUseReviewMd && (!repoOwner || !repoName)) {
          warnExceptInTest(
            '[prepareReviewPayload] Cannot fetch REVIEW.md for invalid GitHub repo',
            {
              platform,
              repoFullName: review.repo_full_name,
              baseRef: review.base_ref,
            }
          );
        }

        // Build complete review state for intelligent update/create decisions
        try {
          // Fetch all state in parallel for efficiency
          const [summaryComment, inlineComments, headCommitSha, reviewInstructions] =
            await Promise.all([
              findKiloReviewComment(installationId, repoOwner, repoName, review.pr_number, appType),
              fetchPRInlineComments(installationId, repoOwner, repoName, review.pr_number, appType),
              getPRHeadCommit(installationId, repoOwner, repoName, review.pr_number, appType),
              repositoryReviewInstructionsPromise ??
                Promise.resolve(repositoryReviewInstructionsLookup),
            ]);
          repositoryReviewInstructionsLookup = reviewInstructions;

          existingReviewState = buildReviewState(summaryComment, inlineComments, headCommitSha);

          logExceptInTest('[prepareReviewPayload] Built GitHub review state', {
            reviewId,
            hasSummary: !!summaryComment,
            inlineCount: inlineComments.length,
            previousStatus: existingReviewState.previousStatus,
            headCommitSha: headCommitSha.substring(0, 8),
          });
        } catch (stateLookupError) {
          if (repositoryReviewInstructionsPromise) {
            repositoryReviewInstructionsLookup = await repositoryReviewInstructionsPromise;
          }
          // Non-critical - continue without state info
          logExceptInTest('[prepareReviewPayload] Failed to build GitHub review state:', {
            reviewId,
            error: stateLookupError,
          });
        }
      } else if (platform === 'gitlab') {
        // GitLab: Use Project Access Token (PrAT) for all operations
        // PrAT is required for cloning private repos and for the glab CLI.
        // Unlike GitHub, we cannot fall back to no-token for GitLab private repos,
        // so auth errors here are hard failures that must propagate.
        const metadata = integration.metadata as GitLabIntegrationMetadata | null;
        gitlabInstanceUrl = (metadata?.gitlab_instance_url || 'https://gitlab.com').replace(
          /\/+$/,
          ''
        );
        const instanceUrl = gitlabInstanceUrl;

        logExceptInTest('[prepareReviewPayload] GitLab integration found', {
          integrationId: integration.id,
          instanceUrl,
        });

        // Get or create Project Access Token (PrAT) for all GitLab operations
        const projectId = review.platform_project_id;

        if (!projectId) {
          throw new Error(
            `GitLab code review requires platform_project_id. ` +
              `Review ${reviewId} for ${review.repo_full_name} is missing this field.`
          );
        }

        try {
          gitlabToken = await getOrCreateProjectAccessToken(integration, projectId);
          logExceptInTest('[prepareReviewPayload] Using PrAT for code review', {
            reviewId,
            repoFullName: review.repo_full_name,
            projectId,
          });
        } catch (pratError) {
          if (pratError instanceof GitLabProjectAccessTokenPermissionError) {
            throw new Error(
              `Cannot create Project Access Token for GitLab code review. ` +
                `You need Maintainer role or higher on project ${review.repo_full_name}. ` +
                `Error: ${pratError.message}`
            );
          }
          throw new Error(
            `Failed to create Project Access Token for GitLab code review on ${review.repo_full_name}. ` +
              `Error: ${pratError instanceof Error ? pratError.message : String(pratError)}`
          );
        }
        const projectAccessToken = gitlabToken;

        try {
          repositorySize = await fetchGitLabRepositorySize(
            projectAccessToken,
            review.repo_full_name,
            instanceUrl
          );
          logExceptInTest('[prepareReviewPayload] Repository size lookup complete', {
            platform,
            repoFullName: review.repo_full_name,
            repositorySize,
            repositorySizeKnown: repositorySize !== null,
          });
        } catch (error) {
          warnExceptInTest('[prepareReviewPayload] Repository size lookup failed; continuing', {
            platform,
            repoFullName: review.repo_full_name,
            error: getReviewInstructionsFetchErrorMetadata(error),
          });
        }

        const repositoryReviewInstructionsPromise = shouldUseReviewMd
          ? fetchRepositoryReviewInstructions({
              platform,
              repoFullName: review.repo_full_name,
              baseRef: review.base_ref,
              fetchInstructions: () =>
                fetchGitLabRootTextFileAtRef(
                  projectAccessToken,
                  review.repo_full_name,
                  REVIEW_INSTRUCTIONS_FILE,
                  review.base_ref,
                  instanceUrl
                ),
            })
          : undefined;

        // Build complete review state for GitLab (using PrAT for reading)
        try {
          const mrIid = review.pr_number;
          // Use repo_full_name as the project path for GitLab API calls
          const repoPath = review.repo_full_name;

          // Fetch all state in parallel for efficiency (using PrAT)
          const [summaryNote, inlineComments, headCommitSha, diffRefs, reviewInstructions] =
            await Promise.all([
              findKiloReviewNote(gitlabToken, repoPath, mrIid, instanceUrl),
              fetchMRInlineComments(gitlabToken, repoPath, mrIid, instanceUrl),
              getMRHeadCommit(gitlabToken, repoPath, mrIid, instanceUrl),
              getMRDiffRefs(gitlabToken, repoPath, mrIid, instanceUrl),
              repositoryReviewInstructionsPromise ??
                Promise.resolve(repositoryReviewInstructionsLookup),
            ]);
          repositoryReviewInstructionsLookup = reviewInstructions;

          // Convert GitLab note format to common format
          const summaryComment = summaryNote
            ? { commentId: summaryNote.noteId, body: summaryNote.body }
            : null;

          // Convert GitLab inline comments to common format
          const convertedInlineComments = inlineComments.map(c => ({
            id: c.id,
            path: c.path,
            line: c.line,
            body: c.body,
            isOutdated: c.isOutdated,
          }));

          existingReviewState = buildReviewState(
            summaryComment,
            convertedInlineComments,
            headCommitSha
          );

          // Store GitLab diff context for prompt generation
          gitlabContext = {
            baseSha: diffRefs.baseSha,
            startSha: diffRefs.startSha,
            headSha: diffRefs.headSha,
          };

          logExceptInTest('[prepareReviewPayload] Built GitLab review state', {
            reviewId,
            hasSummary: !!summaryNote,
            inlineCount: inlineComments.length,
            previousStatus: existingReviewState.previousStatus,
            headCommitSha: headCommitSha.substring(0, 8),
          });
        } catch (stateLookupError) {
          if (repositoryReviewInstructionsPromise) {
            repositoryReviewInstructionsLookup = await repositoryReviewInstructionsPromise;
          }
          // Non-critical - continue without state info
          logExceptInTest('[prepareReviewPayload] Failed to build GitLab review state:', {
            reviewId,
            error: stateLookupError,
          });
        }
      } else {
        throw new Error(
          `Provider Code Reviewer job ${reviewId} has invalid ${platform} integration`
        );
      }
    }

    // 4. Check for previous completed review (incremental review optimization).
    // Keep previousHeadSha for prompt diff context, but disable GitHub session
    // continuation because sendMessageV2 does not refetch refs/pull/<n>/head.
    let previousHeadSha: string | null = null;
    let previousCloudAgentSessionId: string | undefined;
    try {
      const previousReview =
        manualConfig === null
          ? await findPreviousCompletedReview(
              reviewScope,
              existingReviewState?.headCommitSha ?? review.head_sha
            )
          : null;
      previousHeadSha = previousReview?.head_sha ?? null;

      if (previousReview?.session_id) {
        switch (platform) {
          case PLATFORM.GITHUB:
            logExceptInTest(
              '[prepareReviewPayload] Disabling GitHub session continuation for pull-ref checkout safety',
              {
                reviewId,
                previousCloudAgentSessionId: previousReview.session_id,
                upstreamBranch: getGitHubPullRequestCheckoutRef(review.pr_number),
              }
            );
            break;
          case PLATFORM.GITLAB:
            previousCloudAgentSessionId = previousReview.session_id;
            break;
        }
      }

      if (previousHeadSha) {
        logExceptInTest(
          '[prepareReviewPayload] Found previous completed review for incremental mode',
          {
            reviewId,
            previousHeadSha: previousHeadSha.substring(0, 8),
            currentHeadSha: review.head_sha.substring(0, 8),
            previousSessionIdAvailable: !!previousReview?.session_id,
            previousCloudAgentSessionId,
          }
        );
      } else {
        logExceptInTest(
          '[prepareReviewPayload] No previous completed review found, using full review',
          { reviewId }
        );
      }
    } catch (error) {
      // Non-critical - fall back to full review
      logExceptInTest(
        '[prepareReviewPayload] Failed to fetch previous review, falling back to full review:',
        {
          reviewId,
          error,
        }
      );
    }

    await Promise.all([
      updatePreviousReviewSummary(reviewId, {
        body: existingReviewState?.summaryComment?.body ?? null,
        headSha: existingReviewState?.summaryComment ? previousHeadSha : null,
      }),
      updateRepositoryReviewInstructionsMetadata(reviewId, {
        used: repositoryReviewInstructionsLookup.used,
        ref: repositoryReviewInstructionsLookup.ref,
        truncated: repositoryReviewInstructionsLookup.truncated,
      }),
    ]);

    // 5. Generate auth token for cloud agent with bot identifier
    const authToken = generateApiToken(user, { botId: 'reviewer' });

    // A council run replaces the standard sub-agent sharding policy with a coordinator
    // contract (one sub-agent per specialist, no self-review), so the base prompt must OMIT
    // that policy — otherwise the two sets of sub-agent instructions contradict and a small
    // PR could skip specialists and fail closed. Determined here so the prompt is generated
    // without the policy; reused by the council fork below.
    const councilConfig = config.council;
    const councilActive = review.review_type === 'council' && isCouncilActive(councilConfig);

    // 6. Generate dynamic review prompt
    const { prompt, version } = await generateReviewPrompt(
      config,
      review.repo_full_name,
      review.pr_number,
      {
        reviewId,
        existingReviewState,
        platform,
        gitlabContext,
        previousHeadSha,
        repositoryReviewInstructions: repositoryReviewInstructionsLookup.content,
        manualInstructions: manualConfig?.instructions ?? null,
        outputMode,
        expectedHeadSha: review.head_sha,
        omitSubAgentGuidance: councilActive,
      }
    );

    logExceptInTest('[prepareReviewPayload] Generated prompt:', {
      reviewId,
      platform,
      version,
      promptLength: prompt.length,
      hasRepositoryReviewInstructions: repositoryReviewInstructionsLookup.used,
    });

    // 7. Prepare session input
    // Note: cloud-agent automatically sets GH_TOKEN/GITLAB_TOKEN from token parameters
    // Build platform-specific session input
    // GitHub: uses githubRepo (owner/repo format) + githubToken
    // GitLab: uses gitUrl (full HTTPS URL) + gitToken
    const variant = config.thinking_effort ?? undefined;
    // Single source for the standard reviewer's model so the session input and the
    // forward-shaped `reviewAgents[0]` can never drift apart.
    const standardModel = config.model_slug || DEFAULT_CODE_REVIEW_MODEL;
    const gateThreshold = config.gate_threshold ?? 'off';
    const githubCheckoutRef = getGitHubPullRequestCheckoutRef(review.pr_number);
    const sessionInput: SessionInput =
      outputMode === 'kilo'
        ? {
            gitUrl:
              platform === PLATFORM.GITLAB
                ? `https://gitlab.com/${review.repo_full_name}.git`
                : `https://github.com/${review.repo_full_name}.git`,
            kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
            prompt,
            mode: DEFAULT_CODE_REVIEW_MODE as 'code',
            model: standardModel,
            variant,
            upstreamBranch: review.head_ref,
          }
        : platform === 'gitlab'
          ? {
              // GitLab: use full git URL for cloning
              gitUrl: `${gitlabInstanceUrl || 'https://gitlab.com'}/${review.repo_full_name}.git`,
              gitToken: gitlabToken,
              platform: 'gitlab',
              kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
              prompt,
              mode: DEFAULT_CODE_REVIEW_MODE as 'code',
              model: standardModel,
              variant,
              upstreamBranch: review.head_ref,
              ...(gateThreshold !== 'off' ? { gateThreshold } : {}),
            }
          : {
              // GitHub: use owner/repo format
              githubRepo: review.repo_full_name,
              githubToken,
              platform: 'github',
              kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
              prompt,
              mode: DEFAULT_CODE_REVIEW_MODE as 'code',
              model: standardModel,
              variant,
              upstreamBranch: githubCheckoutRef,
              ...(gateThreshold !== 'off' ? { gateThreshold } : {}),
            };

    // Council fork: a council run delegates to one sub-agent per specialist (each on its
    // own model) in a single session. We build `reviewAgents` (domain contract) and the
    // cloud-agent-next `runtimeAgents` (execution), and swap the prompt to the coordinator
    // prompt. `councilActive` (computed above, gating `omitSubAgentGuidance`) guarantees the
    // config is enabled with >= the minimum specialists.
    const councilMembers = councilActive && councilConfig ? enabledSpecialists(councilConfig) : [];
    const aggregationStrategy = councilConfig?.aggregation_strategy ?? 'any_blocking_member';

    // Forward-shaped agent selections. Standard = a single 'standard' agent mirroring the
    // session's model/effort; council = one entry per enabled specialist.
    const reviewAgents: ReviewAgentsConfig = councilActive
      ? {
          reviewType: 'council',
          aggregationStrategy,
          agents: councilMembers.map(specialist => ({
            role: specialist.role,
            model: specialist.model_slug ?? standardModel,
            thinkingEffort: specialist.thinking_effort ?? null,
          })),
        }
      : {
          reviewType: 'standard',
          agents: [
            {
              role: 'standard',
              model: standardModel,
              thinkingEffort: config.thinking_effort ?? null,
            },
          ],
        };

    if (councilActive) {
      // The primary agent coordinates; specialists run as inline sub-agents on their own
      // models. Override the prompt and attach runtimeAgents on whichever sessionInput
      // variant was built above.
      sessionInput.prompt = buildCouncilOrchestratorPrompt({
        basePrompt: prompt,
        specialists: councilMembers,
        aggregationStrategy,
      });
      sessionInput.runtimeAgents = buildCouncilRuntimeAgents({
        specialists: councilMembers,
        defaultModel: standardModel,
        defaultVariant: variant,
      });
    }

    // Log the session input for GitLab
    if (platform === 'gitlab') {
      logExceptInTest('[prepareReviewPayload] GitLab session input prepared', {
        gitUrl: sessionInput.gitUrl,
        hasGitToken: !!sessionInput.gitToken,
        outputMode,
        upstreamBranch: sessionInput.upstreamBranch,
        model: sessionInput.model,
      });
    } else {
      logExceptInTest('[prepareReviewPayload] GitHub session input prepared', {
        githubRepo: sessionInput.githubRepo,
        gitUrl: sessionInput.gitUrl,
        hasGithubToken: !!sessionInput.githubToken,
        outputMode,
        upstreamBranch: sessionInput.upstreamBranch,
        model: sessionInput.model,
      });
    }

    // 8. Build complete payload
    const payload: CodeReviewPayload = {
      reviewId,
      authToken,
      sessionInput,
      owner,
      previousCloudAgentSessionId,
      repositorySize,
      reviewAgents,
    };

    logExceptInTest('[prepareReviewPayload] Prepared payload', {
      reviewId,
      platform,
      owner,
      repositorySize,
      sessionInput: {
        ...sessionInput,
        githubToken: sessionInput.githubToken ? '***' : undefined, // Redact token
        gitToken: sessionInput.gitToken ? '***' : undefined, // Redact token
        promptLength: sessionInput.prompt.length,
      },
    });

    return payload;
  } catch (error) {
    errorExceptInTest('[prepareReviewPayload] Error preparing payload:', error);
    captureException(error, {
      tags: { operation: 'prepareReviewPayload' },
      extra: { reviewId, owner, platform },
    });
    throw error;
  }
}

type RepositoryReviewInstructionsLookup = {
  content: string | null;
  used: boolean;
  ref: string | null;
  truncated: boolean;
};

function unusedRepositoryReviewInstructionsLookup(): RepositoryReviewInstructionsLookup {
  return { content: null, used: false, ref: null, truncated: false };
}

async function fetchRepositoryReviewInstructions(params: {
  platform: CodeReviewPlatform;
  repoFullName: string;
  baseRef: string;
  fetchInstructions: () => Promise<string | null>;
}): Promise<RepositoryReviewInstructionsLookup> {
  try {
    const rawInstructions = await params.fetchInstructions();
    const normalized = normalizeRepositoryReviewInstructions(rawInstructions);

    logExceptInTest('[prepareReviewPayload] REVIEW.md lookup complete', {
      platform: params.platform,
      repoFullName: params.repoFullName,
      baseRef: params.baseRef,
      found: !!normalized,
      truncated: normalized?.truncated ?? false,
    });

    if (!normalized) {
      return unusedRepositoryReviewInstructionsLookup();
    }

    return {
      content: normalized.content,
      used: true,
      ref: params.baseRef,
      truncated: normalized.truncated,
    };
  } catch (error) {
    warnExceptInTest('[prepareReviewPayload] REVIEW.md lookup failed; using default guidance', {
      platform: params.platform,
      repoFullName: params.repoFullName,
      baseRef: params.baseRef,
      error: getReviewInstructionsFetchErrorMetadata(error),
    });
    return unusedRepositoryReviewInstructionsLookup();
  }
}

function getReviewInstructionsFetchErrorMetadata(error: unknown): {
  name?: string;
  message?: string;
  status?: number;
} {
  const metadata: { name?: string; message?: string; status?: number } = {};

  if (error instanceof Error) {
    metadata.name = error.name;
    metadata.message = error.message;
  }

  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    if (typeof status === 'number') {
      metadata.status = status;
    }
  }

  return metadata;
}

/**
 * Build review state from summary comment and inline comments
 * Common logic for both GitHub and GitLab
 */
function buildReviewState(
  summaryComment: { commentId: number; body: string } | null,
  inlineComments: Array<{
    id: number;
    path: string;
    line: number | null;
    body: string;
    isOutdated: boolean;
  }>,
  headCommitSha: string
): ExistingReviewState {
  // Determine previous status from summary body
  let previousStatus: PreviousReviewStatus = 'no-review';
  if (summaryComment) {
    const currentSummary = getCurrentReviewSummaryForContext(summaryComment.body);
    if (currentSummary.includes('No Issues Found') || currentSummary.includes('No New Issues')) {
      previousStatus = 'no-issues';
    } else if (
      currentSummary.includes('Issues Found') ||
      currentSummary.includes('WARNING') ||
      currentSummary.includes('CRITICAL')
    ) {
      previousStatus = 'issues-found';
    }
  }

  return {
    summaryComment,
    inlineComments,
    previousStatus,
    headCommitSha,
  };
}
