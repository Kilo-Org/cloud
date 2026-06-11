import type { ClassifierOutput } from '@kilocode/auto-routing-contracts';

// Golden labels grade the axes the decision engine actually consumes.
// subtaskType is intentionally ungraded (high label ambiguity, unused by
// deriveDifficultyTier); riskLevel likewise; requiresTools gets a small weight.
export type ClassifierExpectation = {
  taskType: ClassifierOutput['taskType'];
  contextComplexity: ClassifierOutput['contextComplexity'];
  reasoningComplexity: ClassifierOutput['reasoningComplexity'];
  executionMode: ClassifierOutput['executionMode'];
  requiresTools: boolean;
};

export const CLASSIFIER_FIELD_WEIGHTS: Record<keyof ClassifierExpectation, number> = {
  taskType: 0.3,
  reasoningComplexity: 0.25,
  contextComplexity: 0.15,
  executionMode: 0.2,
  requiresTools: 0.1,
};

export function gradeClassifierOutput(
  expected: ClassifierExpectation,
  actual: ClassifierOutput
): number {
  let score = 0;
  for (const key of Object.keys(CLASSIFIER_FIELD_WEIGHTS) as (keyof ClassifierExpectation)[]) {
    if (actual[key] === expected[key]) score += CLASSIFIER_FIELD_WEIGHTS[key];
  }
  return Number(score.toFixed(4));
}
