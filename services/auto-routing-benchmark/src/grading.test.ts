import { describe, expect, it } from 'vitest';
import type { ClassifierOutput } from '@kilocode/auto-routing-contracts';
import {
  CLASSIFIER_FIELD_WEIGHTS,
  gradeClassifierOutput,
  type ClassifierExpectation,
} from './grading';

const expected: ClassifierExpectation = {
  taskType: 'implementation',
  contextComplexity: 'small',
  reasoningComplexity: 'low',
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

  it('scores a taskType mismatch alone as 0.7', () => {
    expect(gradeClassifierOutput(expected, actualFrom({ taskType: 'debugging' }))).toBe(0.7);
  });

  it('scores a requiresTools mismatch alone as 0.9', () => {
    expect(gradeClassifierOutput(expected, actualFrom({ requiresTools: true }))).toBe(0.9);
  });

  it('ignores ungraded fields like subtaskType and riskLevel', () => {
    expect(
      gradeClassifierOutput(
        expected,
        actualFrom({ subtaskType: 'feature_development', riskLevel: 'high' })
      )
    ).toBe(1);
  });
});

describe('CLASSIFIER_FIELD_WEIGHTS', () => {
  it('sums to 1', () => {
    expect(Object.values(CLASSIFIER_FIELD_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});
