/**
 * Platform Helpers for Code Review Prompt Generation
 *
 * Abstracts platform-specific differences between GitHub and GitLab
 * for CLI commands, API calls, and terminology.
 */

import type { CodeReviewPlatform } from '@/lib/code-reviews/core/schemas';
import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Platform-specific configuration for code review prompts
 */
export type PlatformConfig = {
  /** Platform name for display */
  name: string;
  /** CLI tool name (gh, glab) */
  cli: string;
  /** Term for pull request (PR, MR) */
  prTerm: string;
  /** Term for pull request number placeholder */
  prNumberPlaceholder: string;
  /** API path for issues/MRs */
  issuesPath: string;
  /** API path for pull/merge requests */
  pullsPath: string;
  /** Diff command */
  diffCommand: (prNumber: string | number) => string;
  /** Create comment command template */
  createCommentCommand: (repo: string, prNumber: string | number) => string;
  /** Update comment command template */
  updateCommentCommand: (repo: string, commentId: string | number) => string;
  /** Inline comments API command template */
  inlineCommentsCommand: (repo: string, prNumber: string | number) => string;
  /** Suggestion block syntax */
  suggestionSyntax: string;
};

/**
 * GitHub platform configuration
 */
const githubConfig: PlatformConfig = {
  name: 'GitHub',
  cli: 'gh',
  prTerm: 'PR',
  prNumberPlaceholder: '{PR_NUMBER}',
  issuesPath: 'issues',
  pullsPath: 'pulls',
  diffCommand: prNumber => `gh pr diff ${prNumber}`,
  createCommentCommand: (repo, prNumber) =>
    `gh api repos/${repo}/issues/${prNumber}/comments --input - << 'EOF'\n{\n  "body": "<!-- kilo-review -->\\n## Code Review Summary\\n\\n..."\n}\nEOF`,
  updateCommentCommand: (repo, commentId) =>
    `gh api repos/${repo}/issues/comments/${commentId} -X PATCH --input - << 'EOF'\n{\n  "body": "<!-- kilo-review -->\\n## Code Review Summary\\n\\n..."\n}\nEOF`,
  inlineCommentsCommand: (repo, prNumber) =>
    `gh api repos/${repo}/pulls/${prNumber}/reviews --input - << 'EOF'\n{\n  "event": "COMMENT",\n  "body": "",\n  "comments": [\n    {"path": "src/file.ts", "line": 42, "side": "RIGHT", "body": "**CRITICAL:** Issue"}\n  ]\n}\nEOF`,
  suggestionSyntax: '```suggestion\n{CORRECTED_LINE}\n```',
};

/**
 * GitLab platform configuration
 */
const gitlabConfig: PlatformConfig = {
  name: 'GitLab',
  cli: 'glab',
  prTerm: 'MR',
  prNumberPlaceholder: '{MR_IID}',
  issuesPath: 'issues',
  pullsPath: 'merge_requests',
  diffCommand: mrIid => `glab mr diff ${mrIid}`,
  createCommentCommand: (projectPath, mrIid) =>
    `glab api projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/notes --input - << 'EOF'\n{\n  "body": "<!-- kilo-review -->\\n## Code Review Summary\\n\\n..."\n}\nEOF`,
  updateCommentCommand: (projectPath, noteId) =>
    `glab api projects/${encodeURIComponent(projectPath)}/merge_requests/{MR_IID}/notes/${noteId} -X PUT --input - << 'EOF'\n{\n  "body": "<!-- kilo-review -->\\n## Code Review Summary\\n\\n..."\n}\nEOF`,
  inlineCommentsCommand: (projectPath, mrIid) =>
    `glab api projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/discussions --input - << 'EOF'\n{\n  "body": "**CRITICAL:** Issue",\n  "position": {\n    "base_sha": "{BASE_SHA}",\n    "start_sha": "{START_SHA}",\n    "head_sha": "{HEAD_SHA}",\n    "position_type": "text",\n    "new_path": "src/file.ts",\n    "new_line": 42\n  }\n}\nEOF`,
  suggestionSyntax: '```suggestion:-0+0\n{CORRECTED_LINE}\n```',
};

/**
 * Get platform configuration by platform type
 */
export function getPlatformConfig(platform: CodeReviewPlatform): PlatformConfig {
  switch (platform) {
    case 'github':
      return githubConfig;
    case PLATFORM.GITLAB:
      return gitlabConfig;
    default: {
      // Exhaustive check
      const _exhaustive: never = platform;
      throw new Error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

/**
 * Get the CLI tool name for a platform
 */
export function getCliTool(platform: CodeReviewPlatform): string {
  return getPlatformConfig(platform).cli;
}

/**
 * Get the PR/MR term for a platform
 */
export function getPrTerm(platform: CodeReviewPlatform): string {
  return getPlatformConfig(platform).prTerm;
}

/**
 * Replace platform-specific placeholders in text
 */
export function replacePlatformPlaceholders(
  text: string,
  platform: CodeReviewPlatform,
  values: {
    repository: string;
    prNumber?: string | number;
    commentId?: string | number;
    baseSha?: string;
    startSha?: string;
    headSha?: string;
  }
): string {
  const config = getPlatformConfig(platform);
  let result = text;

  // Replace repository/project path
  result = result.replace(/{REPO}/g, values.repository);
  result = result.replace(/{PROJECT_PATH}/g, values.repository);

  // Replace PR/MR number
  if (values.prNumber !== undefined) {
    result = result.replace(/{PR_NUMBER}/g, String(values.prNumber));
    result = result.replace(/{PR}/g, String(values.prNumber));
    result = result.replace(/{MR_IID}/g, String(values.prNumber));
  }

  // Replace comment ID
  if (values.commentId !== undefined) {
    result = result.replace(/{COMMENT_ID}/g, String(values.commentId));
    result = result.replace(/{NOTE_ID}/g, String(values.commentId));
  }

  // Replace GitLab-specific SHA placeholders
  if (values.baseSha) {
    result = result.replace(/{BASE_SHA}/g, values.baseSha);
  }
  if (values.startSha) {
    result = result.replace(/{START_SHA}/g, values.startSha);
  }
  if (values.headSha) {
    result = result.replace(/{HEAD_SHA}/g, values.headSha);
  }

  // Replace CLI tool name
  result = result.replace(/{CLI}/g, config.cli);

  // Replace PR term
  result = result.replace(/{PR_TERM}/g, config.prTerm);

  return result;
}

/**
 * Get the feature flag name for prompt template by platform
 */
export function getPromptTemplateFeatureFlag(platform: CodeReviewPlatform): string {
  switch (platform) {
    case 'github':
      return 'code-review-prompt-template';
    case PLATFORM.GITLAB:
      return 'code-review-prompt-template-gitlab';
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

/**
 * Terminology mapping for platform-agnostic documentation
 */
export const PLATFORM_TERMINOLOGY = {
  github: {
    pullRequest: 'Pull Request',
    pullRequestShort: 'PR',
    mergeRequest: 'Pull Request',
    repository: 'repository',
    comment: 'comment',
    reviewComment: 'review comment',
    cli: 'gh',
  },
  gitlab: {
    pullRequest: 'Merge Request',
    pullRequestShort: 'MR',
    mergeRequest: 'Merge Request',
    repository: 'project',
    comment: 'note',
    reviewComment: 'discussion',
    cli: 'glab',
  },
} as const;
