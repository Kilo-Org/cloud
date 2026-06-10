export type AutoRoutingClassifierModelResponse = {
  model: string;
  defaultModel: string;
};

export type AutoRoutingAnalyticsPeriod = '1h' | '24h' | '7d' | '30d';

export type AutoRoutingClassifierAnalyticsResponse = {
  period: AutoRoutingAnalyticsPeriod;
  summary: {
    totalRequests: number;
    classifiedRequests: number;
    classifierErrors: number;
    invalidRequests: number;
    totalCostCredits: number;
    avgDurationMs: number;
    p95DurationMs: number;
    avgConfidence: number;
    withSessionId: number;
    uniqueSessions: number;
    requiresTools: number;
    mirroredHasTools: number;
    avgBodyBytes: number;
  };
  statusBreakdown: Array<{ status: string; requests: number }>;
  taskTypeBreakdown: Array<{ taskType: string; requests: number; avgConfidence: number }>;
  classifierModelBreakdown: Array<{ classifierModel: string; requests: number }>;
};
