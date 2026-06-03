import { z } from 'zod';

const routeSegmentSchema = z.string().min(1);

export const UserConnectRouteParamsSchema = z.object({
  userId: routeSegmentSchema,
  configId: routeSegmentSchema,
  routeKey: routeSegmentSchema,
});

export const OrgConnectRouteParamsSchema = z.object({
  orgId: routeSegmentSchema,
  configId: routeSegmentSchema,
  routeKey: routeSegmentSchema,
});

export type UserConnectRouteParams = z.infer<typeof UserConnectRouteParamsSchema>;
export type OrgConnectRouteParams = z.infer<typeof OrgConnectRouteParamsSchema>;
