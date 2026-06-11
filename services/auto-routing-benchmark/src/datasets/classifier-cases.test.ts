import { describe, expect, it } from 'vitest';
import { NormalizedClassifierInputSchema } from '@kilocode/auto-routing-contracts';
import { CLASSIFIER_CASES } from './classifier-cases';

describe('CLASSIFIER_CASES', () => {
  it('has exactly 36 cases', () => {
    expect(CLASSIFIER_CASES.length).toBe(36);
  });

  it('has unique ids and valid inputs', () => {
    const ids = new Set(CLASSIFIER_CASES.map(c => c.id));
    expect(ids.size).toBe(CLASSIFIER_CASES.length);
    for (const c of CLASSIFIER_CASES) {
      const result = NormalizedClassifierInputSchema.safeParse(c.input);
      expect(result.success, `case ${c.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('covers every task type with exactly 6 cases', () => {
    const byType = Map.groupBy(CLASSIFIER_CASES, c => c.expected.taskType);
    for (const taskType of [
      'implementation',
      'debugging',
      'refactoring',
      'planning_design',
      'investigation',
      'agentic_execution',
    ] as const) {
      expect(byType.get(taskType)?.length ?? 0, taskType).toBe(6);
    }
  });

  it('covers every reasoning complexity at least 8 times', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(
        CLASSIFIER_CASES.filter(c => c.expected.reasoningComplexity === level).length,
        level
      ).toBeGreaterThanOrEqual(8);
    }
  });

  it('has at least one of each reasoning complexity within every task type', () => {
    const byType = Map.groupBy(CLASSIFIER_CASES, c => c.expected.taskType);
    for (const [taskType, cases] of byType) {
      const levels = new Set(cases.map(c => c.expected.reasoningComplexity));
      for (const level of ['low', 'medium', 'high'] as const) {
        expect(levels.has(level), `${taskType} missing ${level}`).toBe(true);
      }
    }
  });
});
