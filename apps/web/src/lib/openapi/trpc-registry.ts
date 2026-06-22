import type * as z from 'zod';
import {
  BreakdownInputSchema,
  BreakdownOutputSchema,
  SummaryOutputSchema,
  TableInputSchema,
  TableOutputSchema,
  TimeseriesInputSchema,
  TimeseriesOutputSchema,
  UsageAnalyticsFiltersSchema,
} from '@/routers/usage-analytics-schemas';

export type TrpcOpenApiProcedure = {
  procedurePath: string;
  method: 'post';
  tags: string[];
  summary: string;
  description?: string;
  input: z.ZodType;
  output: z.ZodType;
  security: 'apiKey';
};

export const publicTrpcOpenApiProcedures = [
  {
    procedurePath: 'usageAnalytics.getSummary',
    method: 'post',
    tags: ['Usage Analytics'],
    summary: 'Get aggregate usage metrics',
    description:
      'Returns aggregate usage metrics for the authenticated user or an accessible organization.',
    input: UsageAnalyticsFiltersSchema,
    output: SummaryOutputSchema,
    security: 'apiKey',
  },
  {
    procedurePath: 'usageAnalytics.getTimeseries',
    method: 'post',
    tags: ['Usage Analytics'],
    summary: 'Get usage over time',
    description:
      'Returns usage analytics grouped into time buckets for the authenticated user or organization.',
    input: TimeseriesInputSchema,
    output: TimeseriesOutputSchema,
    security: 'apiKey',
  },
  {
    procedurePath: 'usageAnalytics.getBreakdown',
    method: 'post',
    tags: ['Usage Analytics'],
    summary: 'Get usage breakdown',
    description: 'Returns top usage values grouped by a selected dimension.',
    input: BreakdownInputSchema,
    output: BreakdownOutputSchema,
    security: 'apiKey',
  },
  {
    procedurePath: 'usageAnalytics.getTable',
    method: 'post',
    tags: ['Usage Analytics'],
    summary: 'Get tabular usage analytics',
    description: 'Returns usage analytics rows grouped by up to three dimensions.',
    input: TableInputSchema,
    output: TableOutputSchema,
    security: 'apiKey',
  },
] satisfies TrpcOpenApiProcedure[];
