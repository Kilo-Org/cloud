import * as z from 'zod';

export const MirrorPathSchema = z.enum(['/chat/completions', '/responses', '/messages']);
export type MirrorPath = z.infer<typeof MirrorPathSchema>;

export const MirrorPayloadSchema = z.object({
  path: MirrorPathSchema,
  receivedAt: z.string().datetime(),
  sessionId: z.string().trim().min(1).nullable(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
export type MirrorPayload = z.infer<typeof MirrorPayloadSchema>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export const NormalizedClassifierInputSchema = z.object({
  apiKind: z.enum(['chat_completions', 'responses', 'messages']),
  requestedModel: z.string(),
  systemPromptPrefix: z.string().nullable(),
  userPromptPrefix: z.string().nullable(),
  latestUserPromptPrefix: z.string().nullable().optional(),
  messageCount: z.number().int().nonnegative().nullable(),
  hasTools: z.boolean(),
  stream: z.boolean(),
  providerHints: z.object({
    provider: JsonValueSchema,
    providerOptions: JsonValueSchema,
  }),
});
export type NormalizedClassifierInput = z.infer<typeof NormalizedClassifierInputSchema>;

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

export const AutoRoutingDecisionResponseSchema = z.object({
  cost: z.number(),
  decision: z.null(),
  classifierResult: z
    .object({
      classification: ClassifierOutputSchema,
      normalized: NormalizedClassifierInputSchema,
    })
    .nullable(),
});
export type AutoRoutingDecisionResponse = z.infer<typeof AutoRoutingDecisionResponseSchema>;

export const UpdateClassifierModelRequestSchema = z.object({
  model: z.string().trim().min(1),
});
export type UpdateClassifierModelRequest = z.infer<typeof UpdateClassifierModelRequestSchema>;

export const AutoRoutingClassifierModelResponseSchema = z.object({
  model: z.string(),
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
    classifierErrors: z.number(),
    invalidRequests: z.number(),
    totalCostCredits: z.number(),
    avgDurationMs: z.number(),
    p95DurationMs: z.number(),
    avgConfidence: z.number(),
    withSessionId: z.number(),
    uniqueSessions: z.number(),
    requiresTools: z.number(),
    mirroredHasTools: z.number(),
    avgBodyBytes: z.number(),
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
