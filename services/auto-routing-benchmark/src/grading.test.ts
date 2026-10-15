import { describe, expect, it } from 'vitest';
import type { ClassifierOutput } from '@kilocode/auto-routing-contracts';
import {
  CLASSIFIER_FIELD_WEIGHTS,
  gradeClassifierOutput,
  gradeDeciderOutput,
  normalizeAnswer,
  runDeciderCheck,
  type ClassifierExpectation,
} from './grading';

const expected: ClassifierExpectation = {
  taskType: 'implementation',
  subtaskType: 'code_generation',
  contextComplexity: 'small',
  reasoningComplexity: 'low',
  riskLevel: 'low',
  executionMode: 'answer_only',
  requiresTools: false,
};

function actualFrom(overrides: Partial<ClassifierOutput>): ClassifierOutput {
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

describe('gradeClassifierOutput', () => {
  it('scores a full match as 1', () => {
    expect(gradeClassifierOutput(expected, actualFrom({}))).toBe(1);
  });

  it('scores a taskType mismatch alone as 0.75', () => {
    expect(gradeClassifierOutput(expected, actualFrom({ taskType: 'debugging' }))).toBe(0.75);
  });

  it('scores a requiresTools mismatch alone as 0.9', () => {
    expect(gradeClassifierOutput(expected, actualFrom({ requiresTools: true }))).toBe(0.9);
  });

  it('scores a combined subtaskType and riskLevel mismatch as 0.85', () => {
    expect(
      gradeClassifierOutput(
        expected,
        actualFrom({ subtaskType: 'feature_development', riskLevel: 'high' })
      )
    ).toBe(0.85);
  });
});

describe('CLASSIFIER_FIELD_WEIGHTS', () => {
  it('sums to 1', () => {
    expect(Object.values(CLASSIFIER_FIELD_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe('normalizeAnswer', () => {
  it('strips fences, lowercases and trims', () => {
    expect(normalizeAnswer('```js\n  Hello World  \n```')).toBe('hello world');
  });
});

describe('runDeciderCheck: exact', () => {
  it('passes with surrounding code fences and different case', () => {
    expect(runDeciderCheck({ kind: 'exact', value: '20-40' }, '```\n20-40\n```')).toBe(true);
    expect(runDeciderCheck({ kind: 'exact', value: 'Hello' }, 'HELLO')).toBe(true);
  });

  it('fails on a wrong answer', () => {
    expect(runDeciderCheck({ kind: 'exact', value: '20-40' }, '20-30')).toBe(false);
  });
});

describe('runDeciderCheck: contains_all', () => {
  it('passes regardless of order and case', () => {
    expect(
      runDeciderCheck({ kind: 'contains_all', values: ['Alpha', 'Beta'] }, 'beta then ALPHA')
    ).toBe(true);
  });

  it('fails when one value is missing', () => {
    expect(
      runDeciderCheck({ kind: 'contains_all', values: ['alpha', 'beta'] }, 'only alpha here')
    ).toBe(false);
  });
});

describe('runDeciderCheck: regex', () => {
  it('passes a basic match with flags', () => {
    expect(
      runDeciderCheck({ kind: 'regex', pattern: '^answer: \\d+$', flags: 'im' }, 'ANSWER: 42')
    ).toBe(true);
  });

  it('fails when the pattern does not match', () => {
    expect(runDeciderCheck({ kind: 'regex', pattern: '^\\d+$' }, 'not a number')).toBe(false);
  });
});

describe('runDeciderCheck: json_equal', () => {
  it('passes with a json fence plus prose before and after', () => {
    const output = 'Here you go:\n```json\n{"a":1}\n```\nLet me know!';
    expect(runDeciderCheck({ kind: 'json_equal', value: { a: 1 } }, output)).toBe(true);
  });

  it('passes with bare JSON', () => {
    expect(runDeciderCheck({ kind: 'json_equal', value: { line: 6 } }, '{"line": 6}')).toBe(true);
  });

  it('fails on unparseable output', () => {
    expect(runDeciderCheck({ kind: 'json_equal', value: { a: 1 } }, 'sorry, no idea')).toBe(false);
  });

  it('fails when values differ', () => {
    expect(runDeciderCheck({ kind: 'json_equal', value: { a: 1 } }, '{"a": 2}')).toBe(false);
  });

  // Documents current behavior: comparison is JSON.stringify-based, so key
  // ORDER is significant. Dataset authoring must mirror the prompted key order.
  it('is sensitive to object key order (documented behavior)', () => {
    expect(runDeciderCheck({ kind: 'json_equal', value: { a: 1, b: 2 } }, '{"b": 2, "a": 1}')).toBe(
      false
    );
  });
});

describe('gradeDeciderOutput', () => {
  const check = {
    kind: 'judged',
    rubric: 'Explains the trade-off',
    reference: 'A reference',
  } as const;

  it('passes through the judge probability and cost', async () => {
    const result = await gradeDeciderOutput(check, {
      userPrompt: 'Choose a design',
      output: 'An answer',
      judge: async input => {
        expect(input).toEqual({
          userPrompt: 'Choose a design',
          output: 'An answer',
          rubric: check.rubric,
          reference: check.reference,
        });
        return { probability: 0.73, costUsd: 0.002 };
      },
    });
    expect(result).toEqual({ score: 0.73, costUsd: 0.002, graderError: null });
  });

  it('reports unavailable judging as retryable without a final score', async () => {
    expect(await gradeDeciderOutput(check, { userPrompt: '', output: '', judge: null })).toEqual({
      score: null,
      costUsd: 0,
      graderError: 'Decider judge is unavailable',
    });
  });

  it('reports a judge failure', async () => {
    const result = await gradeDeciderOutput(check, {
      userPrompt: '',
      output: '',
      judge: async () => {
        throw new Error('Provider failed');
      },
    });
    expect(result).toEqual({ score: null, costUsd: 0, graderError: 'Decider judge failed' });
  });

  it.each([-0.1, 1.1, NaN, Infinity])('rejects invalid probability %s', async probability => {
    const result = await gradeDeciderOutput(check, {
      userPrompt: '',
      output: '',
      judge: async () => ({ probability, costUsd: 0 }),
    });
    expect(result.score).toBeNull();
    expect(result.graderError).toBe('Decider judge failed');
  });

  it.each([
    { check: { kind: 'exact', value: 'YES' } as const, output: 'yes', score: 1 },
    { check: { kind: 'exact', value: 'YES' } as const, output: 'no', score: 0 },
    { check: { kind: 'contains_all', values: ['a', 'b'] } as const, output: 'BA', score: 1 },
    { check: { kind: 'regex', pattern: '^42$' } as const, output: '42', score: 1 },
    { check: { kind: 'json_equal', value: { a: 1 } } as const, output: '{"a":1}', score: 1 },
  ])('preserves mechanical verdicts: $output', async ({ check, output, score }) => {
    expect(await gradeDeciderOutput(check, { userPrompt: '', output, judge: null })).toEqual({
      score,
      costUsd: 0,
      graderError: null,
    });
  });
});
