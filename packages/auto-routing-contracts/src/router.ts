import * as z from 'zod';

export const AUTO_ROUTERS = ['efficient', 'frontier'] as const;
export const AutoRouterSchema = z.enum(AUTO_ROUTERS);
export type AutoRouter = z.infer<typeof AutoRouterSchema>;
export const DEFAULT_AUTO_ROUTER: AutoRouter = 'efficient';

export const AutoRoutingModeSchema = z.enum(['cost_per_accuracy', 'best_accuracy']);
export type AutoRoutingMode = z.infer<typeof AutoRoutingModeSchema>;
export const DEFAULT_AUTO_ROUTING_MODE: AutoRoutingMode = 'cost_per_accuracy';
