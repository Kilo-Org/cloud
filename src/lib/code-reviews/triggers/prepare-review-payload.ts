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
import { kilocode_users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { generateApiToken } from '@/lib/tokens';
import {
  generateGitHubInstallationToken,
  findKiloReviewComment,
  fetchPRInlineComments,
  getPRHeadCommit,
} from '@/lib/integrations/platforms/github/adapter';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  findKiloReviewNote,
  fetchMRInlineComments,
  getMRHeadCommit,
  getMRDiffRefs,
  GitLabProjectAccessTokenPermissionError,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { getOrCreateProjectAccessToken } from '@/lib/integrations/gitlab-service';
import type {
  ExistingReviewState,
  PreviousReviewStatus,
  GitLabDiffContext,
} from '../prompts/generate-prompt';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { getCodeReviewById } from '../db/code-reviews';
import { DEFAULT_CODE_REVIEW_MODEL, DEFAULT_CODE_REVIEW_MODE } from '../core/constants';
import type { Owner } from '../core';
import { generateReviewPrompt } from '../prompts/generate-prompt';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import type { CodeReviewPlatform } from '../core/schemas';
import { PLATFORM } from '@/lib/integrations/core/constants';
/**
 * GitLab integration metadata stored in platform_integrations.metadata
 */
type GitLabIntegrationMetadata = {
  instance_url?: string;
  webhook_secret?: string;
};

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
  upstreamBranch: string;
  /** GitHub installation token (for GitHub platform) */
  githubToken?: string;
  /** Generic git token for authentication (for GitLab and other platforms) */
  gitToken?: string;
  // Note: envVars not needed - cloud-agent auto-sets GH_TOKEN/GITLAB_TOKEN from tokens
};

export type CodeReviewPayload = {
  reviewId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  skipBalanceCheck?: boolean;
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
    let gitlabInstanceUrl: string | undefined;
    let existingReviewState: ExistingReviewState | null = null;
    let gitlabContext: GitLabDiffContext | undefined;

    if (review.platform_integration_id) {
      try {
        const integration = await getIntegrationById(review.platform_integration_id);

        if (platform === 'github' && integration?.platform_installation_id) {
          // Use the stored app type (defaults to 'standard' for existing integrations)
          const appType: GitHubAppType = integration.github_app_type || 'standard';
          // GitHub: Use installation token
          const tokenData = await generateGitHubInstallationToken(
            integration.platform_installation_id,
            appType
          );
          githubToken = tokenData.token;

          // Build complete review state for intelligent update/create decisions
          try {
            const [repoOwner, repoName] = review.repo_full_name.split('/');

            // Fetch all state in parallel for efficiency
            const [summaryComment, inlineComments, headCommitSha] = await Promise.all([
              findKiloReviewComment(
                integration.platform_installation_id,
                repoOwner,
                repoName,
                review.pr_number,
                appType
              ),
              fetchPRInlineComments(
                integration.platform_installation_id,
                repoOwner,
                repoName,
                review.pr_number,
                appType
              ),
              getPRHeadCommit(
                integration.platform_installation_id,
                repoOwner,
                repoName,
                review.pr_number,
                appType
              ),
            ]);

            existingReviewState = buildReviewState(summaryComment, inlineComments, headCommitSha);

            logExceptInTest('[prepareReviewPayload] Built GitHub review state', {
              reviewId,
              hasSummary: !!summaryComment,
              inlineCount: inlineComments.length,
              previousStatus: existingReviewState.previousStatus,
              headCommitSha: headCommitSha.substring(0, 8),
            });
          } catch (stateLookupError) {
            // Non-critical - continue without state info
            logExceptInTest('[prepareReviewPayload] Failed to build GitHub review state:', {
              reviewId,
              error: stateLookupError,
            });
          }
        } else if (platform === PLATFORM.GITLAB && integration) {
          // GitLab: Use Project Access Token (PrAT) for all operations
          // PrAT is required for the glab CLI and Kilocode to work correctly
          const metadata = integration.metadata as GitLabIntegrationMetadata | null;
          gitlabInstanceUrl = metadata?.instance_url || 'https://gitlab.com';
          const instanceUrl = gitlabInstanceUrl;

          logExceptInTest('[prepareReviewPayload] GitLab integration found', {
            integrationId: integration.id,
            instanceUrl,
          });

          // Get or create Project Access Token (PrAT) for all GitLab operations
          // This is required because:
          // 1. The glab CLI needs a proper access token (not OAuth)
          // 2. Comments should appear as a bot identity, not the user
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
            // PrAT creation failed - this is a hard failure, not a fallback situation
            // OAuth tokens don't work with glab CLI, so we can't proceed
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

          // Build complete review state for GitLab (using PrAT for reading)
          try {
            const mrIid = review.pr_number;
            // Use repo_full_name as the project path for GitLab API calls
            const repoPath = review.repo_full_name;

            // Fetch all state in parallel for efficiency (using PrAT)
            const [summaryNote, inlineComments, headCommitSha, diffRefs] = await Promise.all([
              findKiloReviewNote(gitlabToken, repoPath, mrIid, instanceUrl),
              fetchMRInlineComments(gitlabToken, repoPath, mrIid, instanceUrl),
              getMRHeadCommit(gitlabToken, repoPath, mrIid, instanceUrl),
              getMRDiffRefs(gitlabToken, repoPath, mrIid, instanceUrl),
            ]);

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
            // Non-critical - continue without state info
            logExceptInTest('[prepareReviewPayload] Failed to build GitLab review state:', {
              reviewId,
              error: stateLookupError,
            });
          }
        }
      } catch (authError) {
        captureException(authError, {
          tags: { operation: 'prepareReviewPayload', step: `get-${platform}-token` },
          extra: { reviewId, platformIntegrationId: review.platform_integration_id },
        });
        // Continue without token - cloud agent may still work with public repos
      }
    }

    // 4. Generate auth token for cloud agent with bot identifier
    const authToken = generateApiToken(user, { botId: 'reviewer' });

    // 5. Generate dynamic review prompt (include reviewId for fix link and review state)
    const { prompt, version, source } = await generateReviewPrompt(
      agentConfig.config as CodeReviewAgentConfig,
      review.repo_full_name,
      review.pr_number,
      reviewId,
      existingReviewState,
      platform,
      gitlabContext
    );

    logExceptInTest('[prepareReviewPayload] Generated prompt:', {
      reviewId,
      platform,
      version,
      source,
      promptLength: prompt.length,
    });

    // 6. Prepare session input
    // Note: cloud-agent automatically sets GH_TOKEN/GITLAB_TOKEN from token parameters
    const config = agentConfig.config as CodeReviewAgentConfig;

    // Build platform-specific session input
    // GitHub: uses githubRepo (owner/repo format) + githubToken
    // GitLab: uses gitUrl (full HTTPS URL) + gitToken
    const sessionInput: SessionInput =
      platform === PLATFORM.GITLAB
        ? {
            // GitLab: use full git URL for cloning
            gitUrl: `${gitlabInstanceUrl || 'https://gitlab.com'}/${review.repo_full_name}.git`,
            gitToken: gitlabToken,
            kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
            prompt,
            mode: DEFAULT_CODE_REVIEW_MODE as 'code',
            model: config.model_slug || DEFAULT_CODE_REVIEW_MODEL,
            upstreamBranch: review.head_ref,
          }
        : {
            // GitHub: use owner/repo format
            githubRepo: review.repo_full_name,
            githubToken,
            kilocodeOrganizationId: owner.type === 'org' ? owner.id : undefined,
            prompt,
            mode: DEFAULT_CODE_REVIEW_MODE as 'code',
            model: config.model_slug || DEFAULT_CODE_REVIEW_MODEL,
            upstreamBranch: review.head_ref,
          };

    // Log the session input for GitLab
    if (platform === PLATFORM.GITLAB) {
      logExceptInTest('[prepareReviewPayload] GitLab session input prepared', {
        gitUrl: sessionInput.gitUrl,
        hasGitToken: !!sessionInput.gitToken,
        upstreamBranch: sessionInput.upstreamBranch,
        model: sessionInput.model,
      });
    }

    // 7. Build complete payload
    const payload: CodeReviewPayload = {
      reviewId,
      authToken,
      sessionInput,
      owner,
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
