import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { createTRPCRouteHandler } from '@kilocode/web-shared/lib/trpc/route-handler';
import { rootRouter } from '@/routers/root-router';

export const handleTRPCRequest = createTRPCRouteHandler(createCallerFactory(rootRouter));
