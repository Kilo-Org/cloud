import * as z from 'zod';

export const AutoRoutingClassifierModelResponseSchema = z.object({
  model: z.string(),
  defaultModel: z.string(),
});

export const AutoRoutingAnalyticsPeriodSchema = z.enum(['1h', '24h', '7d', '30d']);

export const AutoRoutingClassifierAnalyticsResponseSchema = z.object({
  period: AutoRoutingAnalyticsPeriodSchema,
  summary: z.object({
    totalRequests: z.number(),
    classifiedRequests: z.number(),
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
  classifierModelBreakdown: z.array(
    z.object({ classifierModel: z.string(), requests: z.number() })
  ),
});

export type AutoRoutingClassifierModelResponse = z.infer<
  typeof AutoRoutingClassifierModelResponseSchema
>;
export type AutoRoutingAnalyticsPeriod = z.infer<typeof AutoRoutingAnalyticsPeriodSchema>;
export type AutoRoutingClassifierAnalyticsResponse = z.infer<
  typeof AutoRoutingClassifierAnalyticsResponseSchema
>;
