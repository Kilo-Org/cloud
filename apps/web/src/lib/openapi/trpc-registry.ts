import type { inferRouterInputs } from '@trpc/server';
import * as z from 'zod';
import { PublicOrganizationMembersSchema } from '@/lib/organizations/organization-types';
import type { usageAnalyticsRouter } from '@/routers/usage-analytics-router';
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
  method: 'get' | 'post';
  tags: string[];
  summary: string;
  description?: string;
  input: z.ZodType;
  output: z.ZodType;
};

export type RestOpenApiRoute = {
  path: string;
  method: 'get' | 'post';
  operationId: string;
  tags: string[];
  summary: string;
  description?: string;
  pathParameters?: Array<{
    name: string;
    description: string;
    schema: z.ZodType;
  }>;
  output: z.ZodType;
};

type UsageAnalyticsProcedureKey = Extract<
  keyof inferRouterInputs<typeof usageAnalyticsRouter>,
  string
>;
type UsageAnalyticsOpenApiProcedure<Key extends UsageAnalyticsProcedureKey> =
  TrpcOpenApiProcedure & {
    procedurePath: `usageAnalytics.${Key}`;
  };

function usageAnalyticsProcedure<Key extends UsageAnalyticsProcedureKey>(
  procedure: UsageAnalyticsOpenApiProcedure<Key>
) {
  return procedure;
}

export const publicTrpcOpenApiProcedures = [
  usageAnalyticsProcedure({
    procedurePath: 'usageAnalytics.getSummary',
    method: 'get',
    tags: ['Usage Analytics'],
    summary: 'Return aggregate KPI metrics',
    description:
      'Returns aggregate KPI metrics for the authenticated user or an accessible organization. Use this for summary cards and high-level totals.',
    input: UsageAnalyticsFiltersSchema,
    output: SummaryOutputSchema,
  }),
  usageAnalyticsProcedure({
    procedurePath: 'usageAnalytics.getTimeseries',
    method: 'get',
    tags: ['Usage Analytics'],
    summary: 'Return usage analytics grouped into time buckets',
    description:
      'Returns usage analytics grouped into time buckets. Use this for trend charts and optional split-by series views.',
    input: TimeseriesInputSchema,
    output: TimeseriesOutputSchema,
  }),
  usageAnalyticsProcedure({
    procedurePath: 'usageAnalytics.getBreakdown',
    method: 'get',
    tags: ['Usage Analytics'],
    summary: 'Return top usage values grouped by dimension',
    description:
      'Returns top usage values grouped by a single selected dimension. Use this for dedicated breakdown charts such as features, models, projects, or users.',
    input: BreakdownInputSchema,
    output: BreakdownOutputSchema,
  }),
  usageAnalyticsProcedure({
    procedurePath: 'usageAnalytics.getTable',
    method: 'get',
    tags: ['Usage Analytics'],
    summary: 'Return aggregated tabular usage rows',
    description:
      'Returns aggregated tabular usage rows grouped by time bucket and optional dimensions. Use this for the detailed breakdown table and CSV export view.',
    input: TableInputSchema,
    output: TableOutputSchema,
  }),
];

export const publicRestOpenApiRoutes = [
  {
    path: '/api/v1/organizations/{id}/members',
    method: 'get',
    operationId: 'organizations_getMembers',
    tags: ['Organizations'],
    summary: 'Return organization members',
    description:
      'Returns active and invited members for an organization the authenticated user can access. Invite tokens and invite URLs are omitted from the response.',
    pathParameters: [
      {
        name: 'id',
        description: 'Organization ID.',
        schema: z.string(),
      },
    ],
    output: PublicOrganizationMembersSchema,
  },
] satisfies RestOpenApiRoute[];
