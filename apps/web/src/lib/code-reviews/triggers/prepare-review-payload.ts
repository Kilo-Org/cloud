/**
 * Prepare Code Review Payload
 *
 * Extracts all preparation logic (DB lookups, token generation, prompt generation)
 * Returns complete payload ready for cloud agent
 *
 * Supports both GitHub and GitLab platforms.
 */

import { captureException } from '@sentry/nextjs';
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
} from '@/lib/integrations/platforms/github/adapter';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  findKiloReviewNote,
  fetchMRInlineComments,
  getMRHeadCommit,
  getMRDiffRefs,
  GitLabProjectAccessTokenPermissionError,
  fetchGitLabRootTextFileAtRef,
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
  updateRepositoryReviewInstructionsMetadata,
  type ReviewContinuationScope,
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
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getGitHubPullRequestCheckoutRef } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-checkout-ref';

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
  platform?: 'github' | 'gitlab';
  /** Gate threshold — when not 'off', the agent should report gateResult in its callback */
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
};

export type CodeReviewPayload = {
  reviewId: string;
  attemptId?: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  skipBalanceCheck?: boolean;
  /** Which cloud agent backend to use: 'v1' (cloud-agent SSE) or 'v2' (cloud-agent-next) */
  agentVersion?: string;
  /** Cloud-agent session ID from a previous completed review, for session continuation */
  previousCloudAgentSessionId?: string;
};

/**
 * Prepare complete payload for code review
 * Does all the heavy lifting: DB queries, token generation, prompt generation
 * Supports both GitHub and GitLab platforms.
 */
export async function prepareReviewPayload(
  params: PreparePayloadParams
): Promise<CodeReviewPayload> {
  const { reviewId, owner, agentConfig, platform = 'github' } = params;
  const config = agentConfig.config as CodeReviewAgentConfig;
  const shouldUseReviewMd = config.disable_review_md === false;

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

    logExceptInTest('[prepareReviewPayload] Found review in DB', {
      reviewId,
      repoFullName: review.repo_full_name,
      prNumber: review.pr_number,
      platformIntegrationId: review.platform_integration_id,
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

    // 3. Get platform token and build review state based on platform
    let githubToken: string | undefined;
    let gitlabToken: string | undefined;
    let reviewContinuationScope: ReviewContinuationScope | null =
      platform === PLATFORM.GITLAB ? null : { platform: 'github' };
    let gitlabInstanceUrl: string | undefined;
    let existingReviewState: ExistingReviewState | null = null;
    let gitlabContext: GitLabDiffContext | undefined;
    let repositoryReviewInstructionsLookup = unusedRepositoryReviewInstructionsLookup();

    if (review.platform_integration_id) {
      const integration = await getIntegrationById(review.platform_integration_id);

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
      } else if (platform === 'gitlab' && integration) {
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
          reviewContinuationScope = {
            platform: 'gitlab',
            integrationId: integration.id,
            projectId,
          };
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
      }
    }

    // 4. Check for previous completed review (incremental review optimization).
    // Keep previousHeadSha for prompt diff context, but disable GitHub session
    // continuation because sendMessageV2 does not refetch refs/pull/<n>/head.
    let previousHeadSha: string | null = null;
    let previousCloudAgentSessionId: string | undefined;
    try {
      const previousReview = reviewContinuationScope
        ? await findPreviousCompletedReview(
            review.repo_full_name,
            review.pr_number,
            existingReviewState?.headCommitSha ?? review.head_sha,
            reviewContinuationScope
          )
        : null;
      previousHeadSha = previousReview?.head_sha ?? null;

      if (previousReview?.session_id) {
        if (platform === PLATFORM.GITHUB) {
          logExceptInTest(
            '[prepareReviewPayload] Disabling GitHub session continuation for pull-ref checkout safety',
            {
              reviewId,
              previousCloudAgentSessionId: previousReview.session_id,
              upstreamBranch: getGitHubPullRequestCheckoutRef(review.pr_number),
            }
          );
        } else {
          previousCloudAgentSessionId = previousReview.session_id;
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

    await updateRepositoryReviewInstructionsMetadata(reviewId, {
      used: repositoryReviewInstructionsLookup.used,
      ref: repositoryReviewInstructionsLookup.ref,
      truncated: repositoryReviewInstructionsLookup.truncated,
    });

    // 5. Generate auth token for cloud agent with bot identifier
    const authToken = generateApiToken(user, { botId: 'reviewer' });

    // 6. Generate dynamic review prompt
    const { prompt, version, source } = await generateReviewPrompt(
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
      }
    );

    logExceptInTest('[prepareReviewPayload] Generated prompt:', {
      reviewId,
      platform,
      version,
      source,
      promptLength: prompt.length,
      hasRepositoryReviewInstructions: repositoryReviewInstructionsLookup.used,
    });

    // 7. Prepare session input
    // Note: cloud-agent automatically sets GH_TOKEN/GITLAB_TOKEN from token parameters
    // Build platform-specific session input
    // GitHub: uses githubRepo (owner/repo format) + githubToken
    // GitLab: uses gitUrl (full HTTPS URL) + gitToken
    const variant = config.thinking_effort ?? undefined;
    const gateThreshold = config.gate_threshold ?? 'off';
    const githubCheckoutRef = getGitHubPullRequestCheckoutRef(review.pr_number);
    const sessionInput: SessionInput =
      platform === 'gitlab'
        ? {
            // GitLab: use full git URL for cloning
            gitUrl: `${gitlabInstanceUrl || 'https://gitlab.com'}/${review.repo_full_name}.git`,
            gitToken: gitlabToken,
            platform: 'gitlab',
            kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
            prompt,
            mode: DEFAULT_CODE_REVIEW_MODE as 'code',
            model: config.model_slug || DEFAULT_CODE_REVIEW_MODEL,
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
            model: config.model_slug || DEFAULT_CODE_REVIEW_MODEL,
            variant,
            upstreamBranch: githubCheckoutRef,
            ...(gateThreshold !== 'off' ? { gateThreshold } : {}),
          };

    // Log the session input for GitLab
    if (platform === 'gitlab') {
      logExceptInTest('[prepareReviewPayload] GitLab session input prepared', {
        gitUrl: sessionInput.gitUrl,
        hasGitToken: !!sessionInput.gitToken,
        upstreamBranch: sessionInput.upstreamBranch,
        model: sessionInput.model,
      });
    } else {
      logExceptInTest('[prepareReviewPayload] GitHub session input prepared', {
        githubRepo: sessionInput.githubRepo,
        hasGithubToken: !!sessionInput.githubToken,
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
    };

    logExceptInTest('[prepareReviewPayload] Prepared payload', {
      reviewId,
      platform,
      owner,
      sessionInput: {
        ...sessionInput,
        githubToken: sessionInput.githubToken ? '***' : undefined, // Redact token
        gitToken: sessionInput.gitToken ? '***' : undefined, // Redact token
        prompt: sessionInput.prompt.substring(0, 200) + '...', // Show first 200 chars
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
    if (
      summaryComment.body.includes('No Issues Found') ||
      summaryComment.body.includes('No New Issues')
    ) {
      previousStatus = 'no-issues';
    } else if (
      summaryComment.body.includes('Issues Found') ||
      summaryComment.body.includes('WARNING') ||
      summaryComment.body.includes('CRITICAL')
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
