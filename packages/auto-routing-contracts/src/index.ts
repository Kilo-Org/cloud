import * as z from 'zod';
import { NormalizedClassifierInputSchema } from './input';
import { DifficultyTierSchema, ReasoningEffortSchema } from './tiers';

export {
  NormalizedClassifierInputSchema,
  type JsonValue,
  type NormalizedClassifierInput,
} from './input';

// What the gateway mirrors to the auto-routing worker per request: the
// already-normalized classifier input plus caller identity. The gateway
// normalizes before sending so the multi-hundred-KB request body never
// leaves it, and skips the mirror entirely when normalization fails.
export const MirrorPayloadSchema = z.object({
  input: NormalizedClassifierInputSchema,
  // Authenticated user id, or the gateway's synthetic anonymous id
  // ('anon:<ip>'). Scopes the worker's conversation identity.
  userId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).nullable(),
  machineId: z.string().trim().min(1).nullable(),
  // Per-message id from the kilocode client, joinable to PostHog feedback.
  clientRequestId: z.string().trim().min(1).nullable(),
  mode: z.string().trim().min(1).nullable(),
  userAgent: z.string().nullable(),
  // Size of the original request body, kept as an analytics dimension now
  // that the body itself is no longer mirrored.
  bodyBytes: z.number().int().nonnegative(),
});
export type MirrorPayload = z.infer<typeof MirrorPayloadSchema>;

export const ClassifierTaskTypeSchema = z.enum([
  'implementation',
  'debugging',
  'refactoring',
  'planning_design',
  'investigation',
  'agentic_execution',
]);
export type ClassifierTaskType = z.infer<typeof ClassifierTaskTypeSchema>;

export const ClassifierSubtaskTypeSchema = z.enum([
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
export type ClassifierSubtaskType = z.infer<typeof ClassifierSubtaskTypeSchema>;

const subtypesByTaskType: Record<ClassifierTaskType, readonly ClassifierSubtaskType[]> = {
  implementation: ['feature_development', 'code_generation', 'test_creation'],
  debugging: ['bug_fixing', 'test_repair', 'root_cause_analysis'],
  refactoring: ['code_cleanup', 'architecture_improvement', 'migration'],
  planning_design: ['architecture_design', 'technical_planning', 'system_design'],
  investigation: ['repo_exploration', 'codebase_understanding', 'external_research'],
  agentic_execution: ['tool_usage', 'terminal_operations', 'multi_step_execution'],
};

export const ClassifierOutputSchema = z
  .strictObject({
    taskType: ClassifierTaskTypeSchema,
    subtaskType: ClassifierSubtaskTypeSchema,
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
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

export const AutoRoutingDecisionSchema = z.object({
  model: z.string(),
  tier: DifficultyTierSchema,
  source: z.enum(['benchmark']),
  tableVersion: z.string(),
  // Mirrors the effort the chosen model was benchmarked with, when set.
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  // True when the session's incumbent model was kept over a cheaper fresh
  // pick. Defaulted so responses from a not-yet-redeployed worker still
  // parse.
  sticky: z.boolean().default(false),
});
export type AutoRoutingDecision = z.infer<typeof AutoRoutingDecisionSchema>;

export const AutoRoutingDecisionResponseSchema = z.object({
  cost: z.number(),
  // Null when classification failed or no routing table is published; the
  // gateway then falls back to its static balanced defaults.
  decision: AutoRoutingDecisionSchema.nullable(),
  classifierResult: z
    .object({
      classification: ClassifierOutputSchema,
      normalized: NormalizedClassifierInputSchema,
    })
    .nullable(),
});
export type AutoRoutingDecisionResponse = z.infer<typeof AutoRoutingDecisionResponseSchema>;

// model: null clears the admin override (benchmark winner takes effect).
export const UpdateClassifierModelRequestSchema = z.object({
  model: z.string().trim().min(1).nullable(),
});
export type UpdateClassifierModelRequest = z.infer<typeof UpdateClassifierModelRequestSchema>;

export const AutoRoutingClassifierModelResponseSchema = z.object({
  // Effective model used by /decide: override ?? benchmark winner ?? default.
  model: z.string(),
  override: z.string().nullable(),
  benchmarkWinner: z.string().nullable(),
  defaultModel: z.string(),
});
export type AutoRoutingClassifierModelResponse = z.infer<
  typeof AutoRoutingClassifierModelResponseSchema
>;

export const AutoRoutingAnalyticsPeriodSchema = z.enum(['1h', '24h', '7d', '30d']);
export type AutoRoutingAnalyticsPeriod = z.infer<typeof AutoRoutingAnalyticsPeriodSchema>;

export const AutoRoutingClassifierAnalyticsResponseSchema = z.object({
  period: AutoRoutingAnalyticsPeriodSchema,
  summary: z.object({
    totalRequests: z.number(),
    classifiedRequests: z.number(),
    cachedRequests: z.number(),
    fallbackRequests: z.number(),
    classifierErrors: z.number(),
    invalidRequests: z.number(),
    totalCostCredits: z.number(),
    avgDurationMs: z.number(),
    p95DurationMs: z.number(),
  }),
  statusBreakdown: z.array(z.object({ status: z.string(), requests: z.number() })),
  taskTypeBreakdown: z.array(
    z.object({ taskType: z.string(), requests: z.number(), avgConfidence: z.number() })
  ),
  taskSubtypeBreakdown: z.array(
    z.object({
      taskType: z.string(),
      subtaskType: z.string(),
      requests: z.number(),
      avgConfidence: z.number(),
    })
  ),
  classifierModelBreakdown: z.array(
    z.object({ classifierModel: z.string(), requests: z.number() })
  ),
});
export type AutoRoutingClassifierAnalyticsResponse = z.infer<
  typeof AutoRoutingClassifierAnalyticsResponseSchema
>;

export { normalizeClassifierInput, redactProviderHints, type ClassifierApiKind } from './normalize';

export * from './tiers';
export * from './routing-table';
export * from './benchmark';
