import { describe, expect, it } from 'vitest';
import { classifierTaxonomy } from '@kilocode/auto-routing-contracts/classifier';
import { DECIDER_CASES, FRONTIER_CASES } from './decider-cases';

const TAXONOMY_PAIRS = classifierTaxonomy.taskTypes.flatMap(taskType =>
  taskType.subtypes.map(subtype => ({ taskType: taskType.id, subtaskType: subtype.id }))
);

const SUBTYPES_BY_TASK_TYPE = new Map(
  classifierTaxonomy.taskTypes.map(taskType => [
    taskType.id,
    new Set(taskType.subtypes.map(subtype => subtype.id)),
  ])
);

describe('DECIDER_CASES', () => {
  it('covers all 18 taxonomy pairs', () => {
    expect(TAXONOMY_PAIRS.length).toBe(18);
  });

  it('has exactly 576 cases with unique ids', () => {
    expect(DECIDER_CASES.length).toBe(576);
    const ids = new Set(DECIDER_CASES.map(c => c.id));
    expect(ids.size).toBe(DECIDER_CASES.length);
  });

  it('has at least 30 cases per (taskType, subtaskType) pair', () => {
    for (const pair of TAXONOMY_PAIRS) {
      const count = DECIDER_CASES.filter(
        c => c.taskType === pair.taskType && c.subtaskType === pair.subtaskType
      ).length;
      expect(count, `${pair.taskType}/${pair.subtaskType}`).toBeGreaterThanOrEqual(30);
    }
  });

  it('labels every case with a subtaskType that belongs to its taskType', () => {
    for (const c of DECIDER_CASES) {
      const subtypes = SUBTYPES_BY_TASK_TYPE.get(c.taskType);
      expect(subtypes, `unknown taskType in case ${c.id}`).toBeDefined();
      expect(
        subtypes?.has(c.subtaskType),
        `case ${c.id}: ${c.subtaskType} does not belong to ${c.taskType}`
      ).toBe(true);
    }
  });

  it('has compilable regex patterns', () => {
    for (const c of DECIDER_CASES) {
      const check = c.check;
      if (check.kind === 'regex') {
        expect(() => new RegExp(check.pattern, check.flags), c.id).not.toThrow();
      }
    }
  });

  it('has json_equal values that round-trip through JSON', () => {
    for (const c of DECIDER_CASES) {
      const check = c.check;
      if (check.kind === 'json_equal') {
        expect(JSON.parse(JSON.stringify(check.value)), c.id).toEqual(check.value);
        expect(
          typeof check.value === 'object' && check.value !== null,
          `${c.id}: json_equal needs an object or array`
        ).toBe(true);
      }
    }
  });

  it('has nonempty exact and contains_all values', () => {
    for (const c of DECIDER_CASES) {
      const check = c.check;
      if (check.kind === 'exact') {
        expect(check.value.length, c.id).toBeGreaterThan(0);
      }
      if (check.kind === 'contains_all') {
        expect(check.values.length, c.id).toBeGreaterThan(0);
        for (const v of check.values) {
          expect(v.length, c.id).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps judged checks to at most 30% of each pair, each with a rubric', () => {
    for (const pair of TAXONOMY_PAIRS) {
      const cases = DECIDER_CASES.filter(
        c => c.taskType === pair.taskType && c.subtaskType === pair.subtaskType
      );
      const judged = cases.filter(c => c.check.kind === 'judged');
      expect(
        judged.length / cases.length,
        `${pair.taskType}/${pair.subtaskType}`
      ).toBeLessThanOrEqual(0.3);
      for (const c of judged) {
        if (c.check.kind === 'judged')
          expect(c.check.rubric.trim().length, c.id).toBeGreaterThan(0);
      }
    }
  });
});

describe('FRONTIER_CASES', () => {
  it('preserves UTF-16 surrogate halves in the Unicode identity counterexample', () => {
    const benchCase = FRONTIER_CASES.find(
      candidate => candidate.id === 'frontier-refactoring-code-cleanup-unicode-key-identity'
    );
    expect(benchCase?.check).toMatchObject({
      kind: 'json_equal',
      value: {
        witnesses: [
          { candidate: 1 },
          {
            candidate: 3,
            actual: {
              value: {
                points: ['é', 'é', '𝌆'].map(text => text.split('')),
              },
            },
          },
        ],
      },
    });
  });
});
