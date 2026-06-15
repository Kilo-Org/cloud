import { describe, expect, it } from 'vitest';
import { deriveDifficultyTier } from './tiers';
import type { ClassifierOutput } from './index';

function classification(overrides: Partial<ClassifierOutput>): ClassifierOutput {
  return {
    taskType: 'implementation',
    subtaskType: 'code_generation',
    contextComplexity: 'small',
    reasoningComplexity: 'low',
    riskLevel: 'low',
    executionMode: 'answer_only',
    requiresTools: false,
    confidence: 0.9,
    ...overrides,
  };
}

describe('deriveDifficultyTier', () => {
  it('classifies trivial answer-only requests as low', () => {
    expect(deriveDifficultyTier(classification({}))).toBe('low');
  });
  it('classifies mid-size code changes as medium', () => {
    expect(
      deriveDifficultyTier(
        classification({
          contextComplexity: 'medium',
          reasoningComplexity: 'medium',
          executionMode: 'code_change',
        })
      )
    ).toBe('medium');
  });
  it('classifies high-reasoning multi-step work as high', () => {
    expect(
      deriveDifficultyTier(
        classification({
          contextComplexity: 'large',
          reasoningComplexity: 'high',
          executionMode: 'multi_step_project',
          riskLevel: 'high',
        })
      )
    ).toBe('high');
  });
  it('high risk tips an otherwise-low request to medium', () => {
    expect(
      deriveDifficultyTier(
        classification({ executionMode: 'multi_step_project', riskLevel: 'high' })
      )
    ).toBe('medium');
  });
  it('high risk tips an otherwise-medium request to high', () => {
    expect(
      deriveDifficultyTier(
        classification({
          reasoningComplexity: 'medium',
          contextComplexity: 'large',
          executionMode: 'code_change',
          riskLevel: 'high',
        })
      )
    ).toBe('high');
  });
  it('is monotonic: bumping reasoning complexity never lowers the tier', () => {
    const tiers = ['low', 'medium', 'high'] as const;
    for (const ctx of ['small', 'medium', 'large'] as const) {
      let prev = 0;
      for (const reasoning of ['low', 'medium', 'high'] as const) {
        const tier = deriveDifficultyTier(
          classification({ contextComplexity: ctx, reasoningComplexity: reasoning })
        );
        const idx = tiers.indexOf(tier);
        expect(idx).toBeGreaterThanOrEqual(prev);
        prev = idx;
      }
    }
  });
});
