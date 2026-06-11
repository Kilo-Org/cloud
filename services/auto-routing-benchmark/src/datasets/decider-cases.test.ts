import { describe, expect, it } from 'vitest';
import { DECIDER_CASES } from './decider-cases';

describe('DECIDER_CASES', () => {
  it('has exactly 30 cases with unique ids', () => {
    expect(DECIDER_CASES.length).toBe(30);
    const ids = new Set(DECIDER_CASES.map(c => c.id));
    expect(ids.size).toBe(DECIDER_CASES.length);
  });

  it('has exactly 10 cases per tier', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(DECIDER_CASES.filter(c => c.tier === tier).length, tier).toBe(10);
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

  it('has generous maxTokens and nonempty prompts', () => {
    for (const c of DECIDER_CASES) {
      expect(c.maxTokens, c.id).toBeGreaterThanOrEqual(512);
      expect(c.systemPrompt.length, c.id).toBeGreaterThan(0);
      expect(c.userPrompt.length, c.id).toBeGreaterThan(0);
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
