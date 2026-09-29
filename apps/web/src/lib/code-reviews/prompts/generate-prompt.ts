/**
 * Code Review Prompt Generation
 *
 * Prompt generation with per-style overrides. Immutable prompt content lives in the checked-in JSON
 * templates. This file selects the platform template, replaces placeholders, adds dynamic review
 * context, and applies checked-in style and summary format overrides.
 */

import { z } from 'zod';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import DEFAULT_PROMPT_TEMPLATE_BITBUCKET from '@/lib/code-reviews/prompts/default-prompt-template-bitbucket.json';
import DEFAULT_PROMPT_TEMPLATE_GITHUB from '@/lib/code-reviews/prompts/default-prompt-template.json';
import DEFAULT_PROMPT_TEMPLATE_GITLAB from '@/lib/code-reviews/prompts/default-prompt-template-gitlab.json';
import { logExceptInTest } from '@/lib/utils.server';
import type { CodeReviewPlatform } from '@/lib/code-reviews/core/schemas';
import { getPlatformConfig } from './platform-helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { sanitizeUserInput } from './prompt-utils';
import { formatRepositoryReviewInstructions } from './repository-review-instructions';
import { getCurrentReviewSummaryForContext } from '../summary/history';

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

export const PromptTemplateSchema = z
  .object({
    version: z.string(),
    systemRole: z.string(),
    hardConstraints: z.string(),
    diffLineGuidance: z.string().optional(),
    subAgentGuidance: z.string().optional(),
    workflow: z.string(),
    whatToReview: z.string(),
    commentFormat: z.string(),
    inlineCommentFooter: z.string().optional(),
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
  })
  .strict();

type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

const githubPromptTemplate = PromptTemplateSchema.parse(DEFAULT_PROMPT_TEMPLATE_GITHUB);
const gitlabPromptTemplate = PromptTemplateSchema.parse(DEFAULT_PROMPT_TEMPLATE_GITLAB);
const bitbucketPromptTemplate = PromptTemplateSchema.parse(DEFAULT_PROMPT_TEMPLATE_BITBUCKET);

function getPromptTemplate(platform: CodeReviewPlatform): PromptTemplate {
  switch (platform) {
    case PLATFORM.GITHUB:
      return githubPromptTemplate;
    case PLATFORM.GITLAB:
      return gitlabPromptTemplate;
    case PLATFORM.BITBUCKET:
      return bitbucketPromptTemplate;
    default: {
      const exhaustivePlatform: never = platform;
      throw new Error(`Unknown platform: ${exhaustivePlatform}`);
    }
  }
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
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
  /** Expected checked-out HEAD SHA. Provider reviews may pass undefined; local/Bitbucket reviews require it. */
  expectedHeadSha?: string | null;
  /** Complete review state for intelligent decisions */
  existingReviewState?: ExistingReviewState | null;
  /** Platform type (defaults to 'github') */
  platform?: CodeReviewPlatform;
  /** GitLab-specific diff context for inline comments */
  gitlabContext?: GitLabDiffContext;
  /** HEAD SHA from a previous completed review (enables incremental mode) */
  previousHeadSha?: string | null;
  /** Root REVIEW.md instructions from the base branch, replacing built-in review policy */
  repositoryReviewInstructions?: string | null;
  /** One-off instructions for a manually created review job. */
  manualInstructions?: string | null;
  /** Persisted manual job output mode. Defaults to provider publishing. */
  outputMode?: 'provider' | 'kilo';
  /**
   * Omit the standard sub-agent sharding policy (the Tiny/Small/Medium tier guidance that
   * tells the primary agent how many sub-agents to spawn and to review/verify findings
   * itself). Council runs REPLACE that policy with a coordinator contract (one sub-agent per
   * specialist, no self-review), so including both would give the model contradictory
   * instructions — on a small PR it could skip specialists and fail closed.
   */
  omitSubAgentGuidance?: boolean;
};

/**
 * Generates a code review prompt based on configuration
 * @param config Agent configuration with review settings
 * @param repository Repository in format "owner/repo" (GitHub) or "namespace/project" (GitLab)
 * @param prNumber Pull request number (GitHub) or merge request IID (GitLab)
 * @param options Optional parameters for review context, platform, and incremental mode
 * @returns Generated prompt and checked-in template version
 */
export async function generateReviewPrompt(
  config: CodeReviewAgentConfig,
  repository: string,
  prNumber?: number,
  options: GenerateReviewPromptOptions = {}
): Promise<{ prompt: string; version: string }> {
  const {
    reviewId,
    expectedHeadSha,
    existingReviewState,
    platform = 'github',
    gitlabContext,
    previousHeadSha,
    repositoryReviewInstructions,
    manualInstructions,
    outputMode = 'provider',
    omitSubAgentGuidance = false,
  } = options;
  if (platform === PLATFORM.BITBUCKET && (!prNumber || !expectedHeadSha)) {
    throw new Error('Bitbucket review prompt requires pull request number and expected head SHA');
  }

  const template = getPromptTemplate(platform);
  const platformConfig = getPlatformConfig(platform);
  const pr = prNumber || `{${platformConfig.prTerm}_NUMBER}`;
  const reviewStyle = config.review_style;

  if (outputMode === 'kilo') {
    return {
      prompt: buildLocalReviewPrompt({
        config,
        repository,
        pr,
        platform,
        platformTerm: platformConfig.prTerm,
        manualInstructions,
        repositoryReviewInstructions,
        expectedHeadSha,
      }),
      version: `${template.version}-local`,
    };
  }

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
      .replace(/{NOTE_ID}/g, commentId ? String(commentId) : '{NOTE_ID}')
      .replace(/{EXPECTED_HEAD_SHA}/g, expectedHeadSha ?? '{EXPECTED_HEAD_SHA}');

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

  if (manualInstructions) {
    prompt += '# PER-REVIEW INSTRUCTIONS\n\n' + sanitizeUserInput(manualInstructions) + '\n\n';
  }

  // 4. Hard constraints (MOST IMPORTANT - always included)
  prompt += template.hardConstraints + '\n\n';

  if (template.diffLineGuidance) {
    prompt += replacePlaceholders(template.diffLineGuidance) + '\n\n';
  }

  if (template.subAgentGuidance && !omitSubAgentGuidance) {
    prompt += template.subAgentGuidance + '\n\n';
  }

  // 5. Workflow with placeholders replaced
  // Use incremental workflow when we have a previous completed review SHA and a summary comment
  if (
    previousHeadSha &&
    template.incrementalReviewWorkflow &&
    existingReviewState?.summaryComment
  ) {
    const activeCount = existingReviewState.inlineComments?.filter(c => !c.isOutdated).length ?? 0;
    const previousSummary = getCurrentReviewSummaryForContext(
      existingReviewState.summaryComment.body
    );
    const incrementalWorkflow = template.incrementalReviewWorkflow
      .replace(/{PREVIOUS_SHA}/g, previousHeadSha)
      .replace(/{PREVIOUS_SUMMARY}/g, previousSummary)
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
  prompt +=
    (repositoryReviewInstructions
      ? formatRepositoryReviewInstructions(repositoryReviewInstructions)
      : template.whatToReview) + '\n\n';

  // 7. Focus areas (if any selected)
  if (config.focus_areas.length > 0) {
    prompt +=
      '# FOCUS AREAS\n\nPay special attention to: ' + config.focus_areas.join(', ') + '\n\n';
  }

  // 8. Comment format (use style override if available, otherwise default)
  const commentFormat = template.commentFormatOverrides?.[reviewStyle] ?? template.commentFormat;
  prompt += commentFormat + '\n\n';

  if (platform === 'github' && template.inlineCommentFooter) {
    prompt += template.inlineCommentFooter + '\n\n';
  }

  // 9. Dynamic context section (separator)
  prompt += '---\n\n# CONTEXT FOR THIS ' + platformConfig.prTerm + '\n\n';
  prompt += `**${platform === PLATFORM.GITLAB ? 'Project' : 'Repository'}:** ${repository}\n`;
  prompt += `**${platformConfig.prTerm} Number:** ${pr}\n\n`;

  if (platform === PLATFORM.BITBUCKET && expectedHeadSha) {
    prompt += `**Expected Head SHA:** \`${expectedHeadSha}\`\n\n`;
  }

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
      const firstLine = escapeMarkdownTableCell(c.body.split('\n')[0].substring(0, 60));
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
  };
}

function buildLocalReviewPrompt(params: {
  config: CodeReviewAgentConfig;
  repository: string;
  pr: number | string;
  platform: CodeReviewPlatform;
  platformTerm: string;
  manualInstructions?: string | null;
  repositoryReviewInstructions?: string | null;
  expectedHeadSha?: string | null;
}): string {
  const promptParts: string[] = [
    'You are Kilo Code Reviewer. Review the checked-out change and return findings only in the final response.',
    `Repository: ${params.repository}`,
    `${params.platformTerm} number: ${params.pr}`,
  ];

  if (params.expectedHeadSha) {
    promptParts.push(
      `Expected HEAD SHA: ${params.expectedHeadSha}`,
      'Before reviewing, verify the checked-out HEAD matches the expected SHA. If it does not match, report that mismatch and stop.'
    );
  }

  const styleGuide = getPromptTemplate(params.platform).styleGuidance?.[params.config.review_style];
  if (styleGuide) promptParts.push(styleGuide);

  if (params.config.custom_instructions) {
    promptParts.push('# CUSTOM INSTRUCTIONS', sanitizeUserInput(params.config.custom_instructions));
  }

  if (params.manualInstructions) {
    promptParts.push('# PER-REVIEW INSTRUCTIONS', sanitizeUserInput(params.manualInstructions));
  }

  promptParts.push(
    '# LOCAL REVIEW RULES',
    '- Review the diff read-only. Do not edit files, commit, push, or create branches.',
    '- Do not call provider CLIs or APIs. Do not post comments, notes, statuses, checks, or reactions.',
    '- Focus on issues introduced by this change, not pre-existing unrelated code.',
    '- Prefer concrete findings over general advice.'
  );

  promptParts.push(
    '# WHAT TO REVIEW',
    params.repositoryReviewInstructions
      ? formatRepositoryReviewInstructions(params.repositoryReviewInstructions)
      : 'Review correctness, reliability, security, data integrity, performance, maintainability, tests, and user-visible behavior.'
  );

  if (params.config.focus_areas.length > 0) {
    promptParts.push(
      '# FOCUS AREAS',
      `Pay special attention to: ${params.config.focus_areas.join(', ')}`
    );
  }

  promptParts.push(
    '# FINAL RESPONSE FORMAT',
    'If you find issues, return each finding with:',
    '- Severity: critical, warning, or suggestion',
    '- Path and line when available',
    '- Explanation of the problem',
    '- Suggested fix',
    'If you find no issues, state that no Code Review Findings were found. Keep the response concise and do not include implementation logs.'
  );

  return promptParts.join('\n\n');
}
