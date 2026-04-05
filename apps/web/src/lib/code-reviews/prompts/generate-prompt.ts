/**
 * Code Review Prompt Generation (v5.5.0)
 *
 * Prompt generation with per-style overrides. Most content lives in the JSON template.
 * This file handles:
 * 1. Loading template from PostHog (remote) or falling back to local JSON
 * 2. Assembling template sections in order
 * 3. Replacing placeholders ({REPO}, {PR}, {COMMENT_ID}, {FIX_LINK})
 * 4. Adding dynamic context (existing comments table)
 * 5. Selecting CREATE vs UPDATE summary command
 * 6. Platform-specific template selection (GitHub vs GitLab)
 * 7. Injecting style guidance, custom instructions, and focus areas from config
 * 8. Applying per-style comment format and summary format overrides
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
import { sanitizeUserInput } from './prompt-utils';

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
  // Incremental review workflow (used instead of `workflow` when a previous review exists)
  incrementalReviewWorkflow: z.string().optional(),
  // Per-style overrides (optional — only needed for non-default styles like roast)
  styleGuidance: z.record(z.string(), z.string()).optional(),
  commentFormatOverrides: z.record(z.string(), z.string()).optional(),
  summaryFormatOverrides: z
    .record(z.string(), z.object({ issuesFound: z.string(), noIssues: z.string() }))
    .optional(),
});

// Template type derived from schema
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

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
 * Merges style override records: { ...local, ...remote }.
 * Remote keys win when both define the same key.
 * When remote is undefined the local values pass through unchanged.
 */
function mergeStyleOverrides<V>(
  local: Record<string, V> | undefined,
  remote: Record<string, V> | undefined
): Record<string, V> | undefined {
  if (!local && !remote) return undefined;
  return { ...local, ...remote };
}

/**
 * Merges a remote (PostHog) template with the local template.
 * Remote wins for all base prompt sections and for style override
 * keys that it explicitly provides. Local style overrides fill in
 * any keys the remote template doesn't define.
 */
export function resolveTemplate(
  remoteTemplate: PromptTemplate | undefined,
  localTemplate: PromptTemplate
): { template: PromptTemplate; source: 'posthog' | 'local' } {
  if (!remoteTemplate) {
    return { template: localTemplate, source: 'local' };
  }

  return {
    template: {
      ...remoteTemplate,
      incrementalReviewWorkflow:
        remoteTemplate.incrementalReviewWorkflow ?? localTemplate.incrementalReviewWorkflow,
      styleGuidance: mergeStyleOverrides(localTemplate.styleGuidance, remoteTemplate.styleGuidance),
      commentFormatOverrides: mergeStyleOverrides(
        localTemplate.commentFormatOverrides,
        remoteTemplate.commentFormatOverrides
      ),
      summaryFormatOverrides: mergeStyleOverrides(
        localTemplate.summaryFormatOverrides,
        remoteTemplate.summaryFormatOverrides
      ),
    },
    source: 'posthog',
  };
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

  const { template, source } = resolveTemplate(remoteTemplate, defaultTemplate);

  logExceptInTest('[loadPromptTemplate] Template resolved', {
    platform,
    version: template.version,
    source,
  });

  return { template, source };
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
 * Optional parameters for prompt generation
 */
export type GenerateReviewPromptOptions = {
  /** Code review ID for generating fix link */
  reviewId?: string;
  /** Complete review state for intelligent decisions */
  existingReviewState?: ExistingReviewState | null;
  /** Platform type (defaults to 'github') */
  platform?: CodeReviewPlatform;
  /** GitLab-specific diff context for inline comments */
  gitlabContext?: GitLabDiffContext;
  /** HEAD SHA from a previous completed review (enables incremental mode) */
  previousHeadSha?: string | null;
};

/**
 * Generates a code review prompt based on configuration
 * @param config Agent configuration with review settings
 * @param repository Repository in format "owner/repo" (GitHub) or "namespace/project" (GitLab)
 * @param prNumber Pull request number (GitHub) or merge request IID (GitLab)
 * @param options Optional parameters for review context, platform, and incremental mode
 * @returns Generated prompt with version and source info
 */
export async function generateReviewPrompt(
  config: CodeReviewAgentConfig,
  repository: string,
  prNumber?: number,
  options: GenerateReviewPromptOptions = {}
): Promise<{ prompt: string; version: string; source: 'posthog' | 'local' }> {
  const {
    reviewId,
    existingReviewState,
    platform = 'github',
    gitlabContext,
    previousHeadSha,
  } = options;
  // Load template from PostHog (remote) or local fallback
  const { template, source } = await loadPromptTemplate(platform);
  const platformConfig = getPlatformConfig(platform);
  const pr = prNumber || `{${platformConfig.prTerm}_NUMBER}`;
  const reviewStyle = config.review_style;

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

  // 2. Style guidance (persona/tone override for non-default styles like roast)
  const styleGuide = template.styleGuidance?.[reviewStyle];
  if (styleGuide) {
    prompt += styleGuide + '\n\n';
  }

  // 3. Custom instructions (user-provided, sanitized to prevent injection)
  if (config.custom_instructions) {
    prompt += '# CUSTOM INSTRUCTIONS\n\n' + sanitizeUserInput(config.custom_instructions) + '\n\n';
  }

  // 4. Hard constraints (MOST IMPORTANT - always included)
  prompt += template.hardConstraints + '\n\n';

  // 5. Workflow with placeholders replaced
  // Use incremental workflow when we have a previous completed review SHA and a summary comment
  if (
    previousHeadSha &&
    template.incrementalReviewWorkflow &&
    existingReviewState?.summaryComment
  ) {
    const activeCount = existingReviewState.inlineComments?.filter(c => !c.isOutdated).length ?? 0;
    const incrementalWorkflow = template.incrementalReviewWorkflow
      .replace(/{PREVIOUS_SHA}/g, previousHeadSha)
      .replace(/{PREVIOUS_SUMMARY}/g, existingReviewState.summaryComment.body)
      .replace(/{ACTIVE_COMMENT_COUNT}/g, String(activeCount));
    prompt += replacePlaceholders(incrementalWorkflow) + '\n\n';
    logExceptInTest('[generateReviewPrompt] Using incremental workflow', {
      reviewId,
      previousHeadSha: previousHeadSha.substring(0, 8),
    });
  } else {
    prompt += replacePlaceholders(template.workflow) + '\n\n';
    if (previousHeadSha) {
      logExceptInTest(
        '[generateReviewPrompt] Falling back to full workflow despite previousHeadSha',
        {
          reviewId,
          hasIncrementalTemplate: !!template.incrementalReviewWorkflow,
          hasSummaryComment: !!existingReviewState?.summaryComment,
        }
      );
    }
  }

  // 6. What to review
  prompt += template.whatToReview + '\n\n';

  // 7. Focus areas (if any selected)
  if (config.focus_areas.length > 0) {
    prompt +=
      '# FOCUS AREAS\n\nPay special attention to: ' + config.focus_areas.join(', ') + '\n\n';
  }

  // 8. Comment format (use style override if available, otherwise default)
  const commentFormat = template.commentFormatOverrides?.[reviewStyle] ?? template.commentFormat;
  prompt += commentFormat + '\n\n';

  // 9. Dynamic context section (separator)
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

  // 10. Existing inline comments table (dynamic - built at runtime)
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

  // 11. Summary format templates (use style override if available, otherwise default)
  const summaryOverride = template.summaryFormatOverrides?.[reviewStyle];
  prompt += (summaryOverride?.issuesFound ?? template.summaryFormatIssuesFound) + '\n\n';
  prompt += (summaryOverride?.noIssues ?? template.summaryFormatNoIssues) + '\n\n';

  // 12. Summary marker note and command (CREATE or UPDATE)
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

  // 13. Fix link (dynamic - only if reviewId provided)
  if (reviewId) {
    const baseUrl = process.env.NEXTAUTH_URL || 'https://kilo.ai';
    const fixLink = `${baseUrl}/cloud-agent-fork/review/${reviewId}`;
    prompt += template.fixLinkTemplate.replace(/{FIX_LINK}/g, fixLink) + '\n\n';
  }

  // 14. Inline comments API call template (from JSON)
  prompt += replacePlaceholders(template.inlineCommentsApi) + '\n';

  return {
    prompt,
    version: template.version,
    source,
  };
}
