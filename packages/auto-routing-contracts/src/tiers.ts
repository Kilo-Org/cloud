import * as z from 'zod';

export const DifficultyTierSchema = z.enum(['low', 'medium', 'high']);

export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
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
// Structural subset of ClassifierOutput: importing the full type from
// ./index would create a module cycle (index re-exports this file).
export type DifficultyTierSignal = {
  reasoningComplexity: 'low' | 'medium' | 'high';
  contextComplexity: 'small' | 'medium' | 'large';
  executionMode: 'answer_only' | 'code_change' | 'command_execution' | 'multi_step_project';
  riskLevel: 'low' | 'medium' | 'high';
};

export function deriveDifficultyTier(classification: DifficultyTierSignal): DifficultyTier {
  const score =
    REASONING_POINTS[classification.reasoningComplexity] +
    CONTEXT_POINTS[classification.contextComplexity] +
    EXECUTION_POINTS[classification.executionMode] +
    RISK_POINTS[classification.riskLevel];
  if (score <= 2) return 'low';
  if (score <= 5) return 'medium';
  return 'high';
}
