import anthropicPrompt from './prompt/anthropic.txt';
import reviewPolicy from './prompt/review-policy.md';
import { buildSkillCatalogPrompt, GITHUB_CLOUD_REVIEW_SKILL } from './prompt/skills';
import soulPrompt from './prompt/soul.txt';
import taskChildPrompt from './prompt/task-child.txt';
import { MAX_REVIEW_PROMPT_CHARACTERS, type StartReviewInput } from './types';
import type { ReviewSnapshot } from './git';

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

export const SYSTEM_PROMPT_VERSION = 'isolate-system-v3';
const SUMMARY_MARKER = '<!-- kilo-review -->';

function safePromptValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function buildSystemPrompt(options: {
  model: string;
  date?: string;
  prepared?: boolean;
}): string {
  const environment = [
    '<env>',
    `model: ${safePromptValue(options.model)}`,
    `date: ${safePromptValue(options.date ?? new Date().toISOString().slice(0, 10))}`,
    'git: true',
    'platform: cloudflare-isolate',
    'repo root: /workspace',
    '</env>',
  ].join('\n');
  return [
    soulPrompt,
    anthropicPrompt,
    environment,
    buildSkillCatalogPrompt(),
    options.prepared
      ? '# PREPARED REVIEW POLICY\nUse the resolved canonical policy and trusted reviewSelection in the user message. No bundled default policy applies. The resolved selection is immutable; never reselect or perform a model-owned fallback.'
      : reviewPolicy,
  ].join('\n');
}

export function buildChildSystemPrompt(
  subagentType: 'general' | 'explore',
  prepared: boolean
): string {
  return [
    prepared ? '' : reviewPolicy,
    taskChildPrompt.trimEnd(),
    GITHUB_CLOUD_REVIEW_SKILL.body,
    subagentType === 'explore'
      ? 'For exploration, prefer narrowing the area with find and grep before deep reads.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function resolveReviewUserMessage(input: StartReviewInput, headSha: string): string {
  if (input.userPrompt?.trim()) {
    if (input.userPrompt.length > MAX_REVIEW_PROMPT_CHARACTERS) {
      throw new Error('Resolved review prompt exceeds the supported context budget');
    }
    return input.userPrompt;
  }
  if (input.preparation) throw new Error('Prepared review prompt is missing');
  return buildReviewUserMessage(input, headSha);
}

export function buildTaskReviewContext(input: StartReviewInput, snapshot: ReviewSnapshot): string {
  return [
    '# RESOLVED PARENT REVIEW POLICY AND CONTEXT\n\n' +
      resolveReviewUserMessage(input, snapshot.headSha),
    '# CAPTURED REVIEW SNAPSHOT\n\n' +
      JSON.stringify({
        repository: `${input.owner}/${input.repo}`,
        pullNumber: input.pullNumber,
        ...snapshot,
        reviewSelection: input.preparation?.reviewSelection ?? {
          requestedMode: 'full',
          effectiveMode: 'full',
        },
      }),
    'The inherited publication, skill activation, and delegation steps belong to the parent only. Investigate only your assigned area using the read-only tools.',
  ].join('\n\n');
}

export function buildReviewUserMessage(input: StartReviewInput, headSha: string): string {
  const context = [
    '---',
    '# CONTEXT FOR THIS PULL REQUEST',
    '',
    `**Repository:** ${input.owner}/${input.repo}`,
    `**Pull Request Number:** ${input.pullNumber}`,
    `**Head SHA:** \`${headSha}\``,
    input.existingSummaryCommentId !== undefined
      ? `**Existing Summary Comment ID:** ${input.existingSummaryCommentId}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');

  return `Review this pull request using the raw/default review policy in the system instructions.\n\n${context}`;
}

export { SUMMARY_MARKER };
