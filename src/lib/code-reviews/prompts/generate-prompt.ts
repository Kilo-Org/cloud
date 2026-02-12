/**
 * Code Review Prompt Generation (v5.4.0)
 *
 * Simplified prompt generation - most content lives in the JSON template.
 * This file only handles:
 * 1. Loading template from PostHog (remote) or falling back to local JSON
 * 2. Assembling template sections in order
 * 3. Replacing placeholders ({REPO}, {PR}, {COMMENT_ID}, {FIX_LINK})
 * 4. Adding dynamic context (existing comments table)
 * 5. Selecting CREATE vs UPDATE summary command
 * 6. Platform-specific template selection (GitHub vs GitLab)
 */

import { z } from 'zod';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { getFeatureFlagPayload } from '@/lib/posthog-feature-flags';
import DEFAULT_PROMPT_TEMPLATE_GITHUB from '@/lib/code-reviews/prompts/default-prompt-template.json';
import DEFAULT_PROMPT_TEMPLATE_GITLAB from '@/lib/code-reviews/prompts/default-prompt-template-gitlab.json';
import { logExceptInTest } from '@/lib/utils.server';
import type { CodeReviewPlatform } from '@/lib/code-reviews/core/schemas';
import { getPromptTemplateFeatureFlag, getPlatformConfig } from './platform-helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Inline comment info for duplicate detection
 */
export type InlineComment = {
  id: number;
  path: string;
  line: number | null;
  body: string;
  isOutdated: boolean;
};

/**
 * Previous review status for state machine
 */
export type PreviousReviewStatus = 'no-review' | 'no-issues' | 'issues-found';

/**
 * Complete review state for intelligent update/create decisions
 */
export type ExistingReviewState = {
  summaryComment: { commentId: number; body: string } | null;
  inlineComments: InlineComment[];
  previousStatus: PreviousReviewStatus;
  headCommitSha: string;
};

/**
 * @deprecated Use ExistingReviewState instead
 */
export type ExistingReviewComment = {
  commentId: number;
  body: string;
};

// Zod schema for validating prompt template structure
const PromptTemplateSchema = z.object({
  version: z.string(),
  systemRole: z.string(),
  hardConstraints: z.string(),
  workflow: z.string(),
  whatToReview: z.string(),
  commentFormat: z.string(),
  summaryFormatIssuesFound: z.string(),
  summaryFormatNoIssues: z.string(),
  summaryMarkerNote: z.string(),
  summaryCommandCreate: z.string(),
  summaryCommandUpdate: z.string(),
  inlineCommentsApi: z.string(),
  fixLinkTemplate: z.string(),
});

// Template type derived from schema
type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

/**
 * Get the default local template for a platform
 */
function getDefaultTemplate(platform: CodeReviewPlatform): PromptTemplate {
  switch (platform) {
    case 'github':
      return DEFAULT_PROMPT_TEMPLATE_GITHUB as PromptTemplate;
    case PLATFORM.GITLAB:
      return DEFAULT_PROMPT_TEMPLATE_GITLAB as PromptTemplate;
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

/**
 * Load prompt template from PostHog or fall back to local
 * @param platform The platform to load template for
 * @returns Template and source indicator
 */
async function loadPromptTemplate(platform: CodeReviewPlatform): Promise<{
  template: PromptTemplate;
  source: 'posthog' | 'local';
}> {
  const featureFlagName = getPromptTemplateFeatureFlag(platform);
  const defaultTemplate = getDefaultTemplate(platform);

  // Try to load from PostHog first
  const remoteTemplate = await getFeatureFlagPayload(PromptTemplateSchema, featureFlagName);

  if (remoteTemplate) {
    logExceptInTest('[loadPromptTemplate] Loaded template from PostHog', {
      platform,
      version: remoteTemplate.version,
    });
    return { template: remoteTemplate, source: 'posthog' };
  }

  // Fall back to local template
  logExceptInTest('[loadPromptTemplate] Using local template', {
    platform,
    version: defaultTemplate.version,
  });
  return { template: defaultTemplate, source: 'local' };
}

/**
 * GitLab-specific context for inline comments
 */
export type GitLabDiffContext = {
  baseSha: string;
  startSha: string;
  headSha: string;
};

/**
 * Generates a code review prompt based on configuration
 * @param config Agent configuration with review settings
 * @param repository Repository in format "owner/repo" (GitHub) or "namespace/project" (GitLab)
 * @param prNumber Pull request number (GitHub) or merge request IID (GitLab)
 * @param reviewId Code review ID for generating fix link (optional)
 * @param existingReviewState Complete review state for intelligent decisions (optional)
 * @param platform Platform type (defaults to 'github' for backward compatibility)
 * @param gitlabContext GitLab-specific diff context for inline comments (optional)
 * @returns Generated prompt with version and source info
 */
export async function generateReviewPrompt(
  _config: CodeReviewAgentConfig, // Reserved for future: custom instructions, focus areas
  repository: string,
  prNumber?: number,
  reviewId?: string,
  existingReviewState?: ExistingReviewState | null,
  platform: CodeReviewPlatform = 'github',
  gitlabContext?: GitLabDiffContext
): Promise<{ prompt: string; version: string; source: 'posthog' | 'local' }> {
  // Load template from PostHog (remote) or local fallback
  const { template, source } = await loadPromptTemplate(platform);
  const platformConfig = getPlatformConfig(platform);
  const pr = prNumber || `{${platformConfig.prTerm}_NUMBER}`;

  // Helper to replace common placeholders
  const replacePlaceholders = (text: string, commentId?: number): string => {
    let result = text
      .replace(/{PR_NUMBER}/g, String(pr))
      .replace(/{MR_IID}/g, String(pr))
      .replace(/{REPO}/g, repository)
      .replace(/{PROJECT_PATH}/g, repository)
      .replace(/{PROJECT_PATH_ENCODED}/g, encodeURIComponent(repository))
      .replace(/{PR}/g, String(pr))
      .replace(/{COMMENT_ID}/g, commentId ? String(commentId) : '{COMMENT_ID}')
      .replace(/{NOTE_ID}/g, commentId ? String(commentId) : '{NOTE_ID}');

    // GitLab-specific SHA placeholders
    if (gitlabContext) {
      result = result
        .replace(/{BASE_SHA}/g, gitlabContext.baseSha)
        .replace(/{START_SHA}/g, gitlabContext.startSha)
        .replace(/{HEAD_SHA}/g, gitlabContext.headSha);
    }

    return result;
  };

  let prompt = '';

  // 1. System role
  prompt += template.systemRole + '\n\n';

  // 2. Hard constraints (MOST IMPORTANT - at top)
  prompt += template.hardConstraints + '\n\n';

  // 3. Workflow with placeholders replaced
  prompt += replacePlaceholders(template.workflow) + '\n\n';

  // 4. What to review
  prompt += template.whatToReview + '\n\n';

  // 5. Comment format
  prompt += template.commentFormat + '\n\n';

  // 6. Dynamic context section (separator)
  prompt += '---\n\n# CONTEXT FOR THIS ' + platformConfig.prTerm + '\n\n';
  prompt += `**${platform === PLATFORM.GITLAB ? 'Project' : 'Repository'}:** ${repository}\n`;
  prompt += `**${platformConfig.prTerm} Number:** ${pr}\n\n`;

  // Add GitLab-specific SHA context if available
  if (platform === PLATFORM.GITLAB && gitlabContext) {
    prompt += `**Diff Context (for inline comments):**\n`;
    prompt += `- Base SHA: \`${gitlabContext.baseSha}\`\n`;
    prompt += `- Start SHA: \`${gitlabContext.startSha}\`\n`;
    prompt += `- Head SHA: \`${gitlabContext.headSha}\`\n\n`;
  }

  // 7. Existing inline comments table (dynamic - built at runtime)
  if (existingReviewState?.inlineComments && existingReviewState.inlineComments.length > 0) {
    const active = existingReviewState.inlineComments.filter(c => !c.isOutdated);

    prompt += `## Existing Inline Comments (${active.length} active)\n\n`;
    prompt += `**DO NOT create duplicates for these issues.**\n\n`;
    prompt += '| File | Line | Issue |\n|------|------|-------|\n';

    for (const c of active.slice(0, 20)) {
      const firstLine = c.body.split('\n')[0].substring(0, 60).replace(/\|/g, '\\|');
      prompt += `| \`${c.path}\` | ${c.line ?? 'N/A'} | ${firstLine} |\n`;
    }

    if (active.length > 20) {
      prompt += `\n*...and ${active.length - 20} more comments*\n`;
    }
    prompt += '\n';
  }

  // 8. Summary format templates (from JSON)
  prompt += template.summaryFormatIssuesFound + '\n\n';
  prompt += template.summaryFormatNoIssues + '\n\n';

  // 9. Summary marker note and command (CREATE or UPDATE)
  prompt += template.summaryMarkerNote + '\n\n';
  if (existingReviewState?.summaryComment) {
    prompt +=
      replacePlaceholders(
        template.summaryCommandUpdate,
        existingReviewState.summaryComment.commentId
      ) + '\n\n';
  } else {
    prompt += replacePlaceholders(template.summaryCommandCreate) + '\n\n';
  }

  // 10. Fix link (dynamic - only if reviewId provided)
  if (reviewId) {
    const baseUrl = process.env.NEXTAUTH_URL || 'https://kilo.ai';
    const fixLink = `${baseUrl}/cloud-agent-fork/review/${reviewId}`;
    prompt += template.fixLinkTemplate.replace(/{FIX_LINK}/g, fixLink) + '\n\n';
  }

  // 11. Inline comments API call template (from JSON)
  prompt += replacePlaceholders(template.inlineCommentsApi) + '\n';

  return {
    prompt,
    version: template.version,
    source,
  };
}
