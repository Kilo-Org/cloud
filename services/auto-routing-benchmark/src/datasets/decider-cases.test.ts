import { describe, expect, it } from 'vitest';
import { classifierTaxonomy } from '@kilocode/auto-routing-contracts/classifier';
import { DECIDER_CASES } from './decider-cases';

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

  it('has exactly 76 cases with unique ids', () => {
    expect(DECIDER_CASES.length).toBe(76);
    const ids = new Set(DECIDER_CASES.map(c => c.id));
    expect(ids.size).toBe(DECIDER_CASES.length);
  });

  it('has at least 4 cases per (taskType, subtaskType) pair', () => {
    for (const pair of TAXONOMY_PAIRS) {
      const count = DECIDER_CASES.filter(
        c => c.taskType === pair.taskType && c.subtaskType === pair.subtaskType
      ).length;
      expect(count, `${pair.taskType}/${pair.subtaskType}`).toBeGreaterThanOrEqual(4);
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

  it('has at least 20 cases per tier', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(DECIDER_CASES.filter(c => c.tier === tier).length, tier).toBeGreaterThanOrEqual(20);
    }
  });

  it('covers at least 4 distinct task types per tier', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const taskTypes = new Set(DECIDER_CASES.filter(c => c.tier === tier).map(c => c.taskType));
      expect(taskTypes.size, tier).toBeGreaterThanOrEqual(4);
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
});
