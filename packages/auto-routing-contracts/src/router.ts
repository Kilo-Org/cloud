import * as z from 'zod';

export const AUTO_ROUTERS = ['efficient', 'frontier'] as const;
export const AutoRouterSchema = z.enum(AUTO_ROUTERS);
export type AutoRouter = z.infer<typeof AutoRouterSchema>;
export const DEFAULT_AUTO_ROUTER: AutoRouter = 'efficient';
