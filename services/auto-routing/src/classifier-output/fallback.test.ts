import { describe, expect, it } from 'vitest';
import type { NormalizedClassifierInput } from '../classifier-input';
import { fallbackClassifierOutput } from './fallback';

const input = {
  apiKind: 'chat_completions',
  requestedModel: 'anthropic/claude-sonnet-4',
  systemPromptPrefix: null,
  userPromptPrefix: 'Add a checkout endpoint.',
  messageCount: 1,
  hasTools: true,
  stream: false,
  providerHints: {
    provider: null,
    providerOptions: null,
  },
} satisfies NormalizedClassifierInput;

describe('fallback classifier output', () => {
  it('returns a valid low-confidence default classification', () => {
    expect(fallbackClassifierOutput(input)).toEqual({
      taskType: 'implementation',
      subtaskType: 'feature_development',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'multi_step_project',
      requiresTools: true,
      confidence: 0,
    });
  });

  it('uses simple intent keywords when available', () => {
    expect(
      fallbackClassifierOutput({
        ...input,
        userPromptPrefix: 'Simplify this PR for maintainability.',
        hasTools: false,
      })
    ).toMatchObject({
      taskType: 'refactoring',
      subtaskType: 'code_cleanup',
      executionMode: 'answer_only',
      requiresTools: false,
      confidence: 0,
    });
  });

  it('uses latest user prompt text for redirected long sessions', () => {
    expect(
      fallbackClassifierOutput({
        ...input,
        userPromptPrefix: 'Write a technical plan for the migration.',
        latestUserPromptPrefix: 'Actually debug and fix the failing worker test.',
        hasTools: false,
      })
    ).toMatchObject({
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
    });
  });
});
