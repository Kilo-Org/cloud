import { describe, expect, it } from 'vitest';
import { NormalizedClassifierInputSchema } from '@kilocode/auto-routing-contracts';
import { classifierTaxonomy } from '@kilocode/auto-routing-contracts/classifier';
import { CLASSIFIER_CASES } from './classifier-cases';

const TAXONOMY_PAIRS = classifierTaxonomy.taskTypes.flatMap(taskType =>
  taskType.subtypes.map(subtype => ({ taskType: taskType.id, subtaskType: subtype.id }))
);

const SUBTYPES_BY_TASK_TYPE = new Map(
  classifierTaxonomy.taskTypes.map(taskType => [
    taskType.id,
    new Set(taskType.subtypes.map(subtype => subtype.id)),
  ])
);

describe('CLASSIFIER_CASES', () => {
  it('covers all 18 taxonomy pairs', () => {
    expect(TAXONOMY_PAIRS.length).toBe(18);
  });

  it('has unique ids and valid inputs', () => {
    const ids = new Set(CLASSIFIER_CASES.map(c => c.id));
    expect(ids.size).toBe(CLASSIFIER_CASES.length);
    for (const c of CLASSIFIER_CASES) {
      const result = NormalizedClassifierInputSchema.safeParse(c.input);
      expect(result.success, `case ${c.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('has at least 4 cases per (taskType, subtaskType) pair', () => {
    for (const pair of TAXONOMY_PAIRS) {
      const count = CLASSIFIER_CASES.filter(
        c => c.expected.taskType === pair.taskType && c.expected.subtaskType === pair.subtaskType
      ).length;
      expect(count, `${pair.taskType}/${pair.subtaskType}`).toBeGreaterThanOrEqual(4);
    }
  });

  it('labels every case with a subtaskType that belongs to its taskType', () => {
    for (const c of CLASSIFIER_CASES) {
      const subtypes = SUBTYPES_BY_TASK_TYPE.get(c.expected.taskType);
      expect(subtypes, `unknown taskType in case ${c.id}`).toBeDefined();
      expect(
        subtypes?.has(c.expected.subtaskType),
        `case ${c.id}: ${c.expected.subtaskType} does not belong to ${c.expected.taskType}`
      ).toBe(true);
    }
  });

  it('covers every task type with exactly 12 cases', () => {
    const counts = new Map<string, number>();
    for (const c of CLASSIFIER_CASES) {
      counts.set(c.expected.taskType, (counts.get(c.expected.taskType) ?? 0) + 1);
    }
    for (const taskType of classifierTaxonomy.taskTypes) {
      expect(counts.get(taskType.id) ?? 0, taskType.id).toBe(12);
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

  it('covers every risk level at least 4 times', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(
        CLASSIFIER_CASES.filter(c => c.expected.riskLevel === level).length,
        level
      ).toBeGreaterThanOrEqual(4);
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
