import * as z from 'zod';

export const CLASSIFIER_TASK_TYPES = [
  'implementation',
  'debugging',
  'refactoring',
  'planning_design',
  'investigation',
  'agentic_execution',
] as const;

export const CLASSIFIER_SUBTASK_TYPES = [
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
] as const;

export const SUBTYPES_BY_TASK_TYPE = {
  implementation: ['feature_development', 'code_generation', 'test_creation'],
  debugging: ['bug_fixing', 'test_repair', 'root_cause_analysis'],
  refactoring: ['code_cleanup', 'architecture_improvement', 'migration'],
  planning_design: ['architecture_design', 'technical_planning', 'system_design'],
  investigation: ['repo_exploration', 'codebase_understanding', 'external_research'],
  agentic_execution: ['tool_usage', 'terminal_operations', 'multi_step_execution'],
} as const;

export const TAXONOMY_ROUTE_KEYS = [
  'implementation/feature_development',
  'implementation/code_generation',
  'implementation/test_creation',
  'debugging/bug_fixing',
  'debugging/test_repair',
  'debugging/root_cause_analysis',
  'refactoring/code_cleanup',
  'refactoring/architecture_improvement',
  'refactoring/migration',
  'planning_design/architecture_design',
  'planning_design/technical_planning',
  'planning_design/system_design',
  'investigation/repo_exploration',
  'investigation/codebase_understanding',
  'investigation/external_research',
  'agentic_execution/tool_usage',
  'agentic_execution/terminal_operations',
  'agentic_execution/multi_step_execution',
] as const;

export const ClassifierTaskTypeSchema = z.enum(CLASSIFIER_TASK_TYPES);
export type ClassifierTaskType = z.infer<typeof ClassifierTaskTypeSchema>;

export const ClassifierSubtaskTypeSchema = z.enum(CLASSIFIER_SUBTASK_TYPES);
export type ClassifierSubtaskType = z.infer<typeof ClassifierSubtaskTypeSchema>;

export const TaxonomyRouteKeySchema = z.enum(TAXONOMY_ROUTE_KEYS);
export type TaxonomyRouteKey = z.infer<typeof TaxonomyRouteKeySchema>;

export function taxonomyRouteKey(params: {
  taskType: ClassifierTaskType;
  subtaskType: ClassifierSubtaskType;
}): TaxonomyRouteKey {
  return `${params.taskType}/${params.subtaskType}` as TaxonomyRouteKey;
}
