import * as z from 'zod';
import type { ClassifierOutput } from './index';

export const DifficultyTierSchema = z.enum(['low', 'medium', 'high']);
export type DifficultyTier = z.infer<typeof DifficultyTierSchema>;

export const DIFFICULTY_TIERS: readonly DifficultyTier[] = ['low', 'medium', 'high'];

const REASONING_POINTS = { low: 0, medium: 2, high: 4 } as const;
const CONTEXT_POINTS = { small: 0, medium: 1, large: 2 } as const;
const EXECUTION_POINTS = {
  answer_only: 0,
  code_change: 1,
  command_execution: 1,
  multi_step_project: 2,
} as const;
const RISK_POINTS = { low: 0, medium: 0, high: 1 } as const;

// Deterministic mapping from the classifier taxonomy to a difficulty tier.
// Reasoning complexity dominates (weight 2x) because it is the strongest
// signal for whether a cheap model can complete the task; context size,
// execution mode and blast radius nudge borderline cases up.
export function deriveDifficultyTier(classification: ClassifierOutput): DifficultyTier {
  const score =
    REASONING_POINTS[classification.reasoningComplexity] +
    CONTEXT_POINTS[classification.contextComplexity] +
    EXECUTION_POINTS[classification.executionMode] +
    RISK_POINTS[classification.riskLevel];
  if (score <= 2) return 'low';
  if (score <= 5) return 'medium';
  return 'high';
}
