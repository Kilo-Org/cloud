import * as z from 'zod';

/**
 * The classifier's task-to-subtype relation. Every other taxonomy list in this
 * module — the flat task and subtype lists, the route keys, and the helper
 * below — is derived from this mapping, so a new or removed pair cannot drift
 * from the keys the routing table stores.
 */
export const SUBTYPES_BY_TASK_TYPE = {
  implementation: ['feature_development', 'code_generation', 'test_creation'],
  debugging: ['bug_fixing', 'test_repair', 'root_cause_analysis'],
  refactoring: ['code_cleanup', 'architecture_improvement', 'migration'],
  planning_design: ['architecture_design', 'technical_planning', 'system_design'],
  investigation: ['repo_exploration', 'codebase_understanding', 'external_research'],
  agentic_execution: ['tool_usage', 'terminal_operations', 'multi_step_execution'],
} as const;

export type ClassifierTaskType = keyof typeof SUBTYPES_BY_TASK_TYPE;
export type ClassifierSubtaskType = (typeof SUBTYPES_BY_TASK_TYPE)[ClassifierTaskType][number];
export type SubtypesOfTaskType<T extends ClassifierTaskType> =
  (typeof SUBTYPES_BY_TASK_TYPE)[T][number];

export const CLASSIFIER_TASK_TYPES: readonly ClassifierTaskType[] = Object.keys(
  SUBTYPES_BY_TASK_TYPE
) as ClassifierTaskType[];

export const CLASSIFIER_SUBTASK_TYPES: readonly ClassifierSubtaskType[] =
  CLASSIFIER_TASK_TYPES.flatMap(taskType => [...SUBTYPES_BY_TASK_TYPE[taskType]]);

type TaxonomyRouteKeysByTaskType = {
  [T in ClassifierTaskType]: `${T}/${SubtypesOfTaskType<T>}`;
};

export type TaxonomyRouteKey = TaxonomyRouteKeysByTaskType[ClassifierTaskType];

export const TAXONOMY_ROUTE_KEYS: readonly TaxonomyRouteKey[] = CLASSIFIER_TASK_TYPES.flatMap(
  taskType =>
    SUBTYPES_BY_TASK_TYPE[taskType].map(subtype => `${taskType}/${subtype}` as TaxonomyRouteKey)
);

export const ClassifierTaskTypeSchema = z.enum(CLASSIFIER_TASK_TYPES);

export const ClassifierSubtaskTypeSchema = z.enum(CLASSIFIER_SUBTASK_TYPES);

export const TaxonomyRouteKeySchema = z.enum(TAXONOMY_ROUTE_KEYS);

/**
 * The route key for a classifier pair. Only subtasks that belong to the given
 * task type typecheck; the interpolation cannot be checked by the compiler
 * because it is a template over a generic parameter.
 */
export function taxonomyRouteKey<T extends ClassifierTaskType>(params: {
  taskType: T;
  subtaskType: SubtypesOfTaskType<T>;
}): TaxonomyRouteKey {
  return `${params.taskType}/${params.subtaskType}` as TaxonomyRouteKey;
}
