import * as z from 'zod';

export const classifierTaskTypeSchema = z.enum([
  'implementation',
  'debugging',
  'refactoring',
  'planning_design',
  'investigation',
  'agentic_execution',
]);

export const classifierSubtaskTypeSchema = z.enum([
  'feature_development',
  'code_generation',
  'test_creation',
  'bug_fixing',
  'test_repair',
  'root_cause_analysis',
  'code_cleanup',
  'architecture_improvement',
  'migration',
  'architecture_design',
  'technical_planning',
  'system_design',
  'repo_exploration',
  'codebase_understanding',
  'external_research',
  'tool_usage',
  'terminal_operations',
  'multi_step_execution',
]);

export type ClassifierTaskType = z.infer<typeof classifierTaskTypeSchema>;
export type ClassifierSubtaskType = z.infer<typeof classifierSubtaskTypeSchema>;

const subtypesByTaskType: Record<ClassifierTaskType, readonly ClassifierSubtaskType[]> = {
  implementation: ['feature_development', 'code_generation', 'test_creation'],
  debugging: ['bug_fixing', 'test_repair', 'root_cause_analysis'],
  refactoring: ['code_cleanup', 'architecture_improvement', 'migration'],
  planning_design: ['architecture_design', 'technical_planning', 'system_design'],
  investigation: ['repo_exploration', 'codebase_understanding', 'external_research'],
  agentic_execution: ['tool_usage', 'terminal_operations', 'multi_step_execution'],
};

export const classifierOutputSchema = z
  .strictObject({
    taskType: classifierTaskTypeSchema,
    subtaskType: classifierSubtaskTypeSchema,
    contextComplexity: z.enum(['small', 'medium', 'large']),
    reasoningComplexity: z.enum(['low', 'medium', 'high']),
    riskLevel: z.enum(['low', 'medium', 'high']),
    executionMode: z.enum([
      'answer_only',
      'code_change',
      'command_execution',
      'multi_step_project',
    ]),
    requiresTools: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .superRefine((output, ctx) => {
    if (!subtypesByTaskType[output.taskType].includes(output.subtaskType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['subtaskType'],
        message: `Subtype ${output.subtaskType} does not belong to task type ${output.taskType}`,
      });
    }
  });

export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

export function parseClassifierOutput(text: string): ClassifierOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Classifier model returned invalid JSON');
  }

  return classifierOutputSchema.parse(parsed);
}
