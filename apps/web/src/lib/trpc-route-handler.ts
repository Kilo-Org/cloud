import { createCallerFactory } from '@/lib/trpc/init';
import { createTRPCRouteHandler } from '@/lib/trpc/route-handler';
import { rootRouter } from '@/routers/root-router';

export const handleTRPCRequest = createTRPCRouteHandler(createCallerFactory(rootRouter));
