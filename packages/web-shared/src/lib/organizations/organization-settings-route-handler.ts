import { createCallerFactory, createTRPCRouter } from '@/lib/trpc/init';
import { createTRPCRouteHandler } from '@/lib/trpc/route-handler';
import { listAvailableModelsProcedure } from '@/routers/organizations/organization-available-models-procedure';

// Mounts listAvailableModels at its root-router path, so callers keep using
// `caller.organizations.settings.listAvailableModels` without importing every router.
const organizationSettingsRouter = createTRPCRouter({
  organizations: createTRPCRouter({
    settings: createTRPCRouter({ listAvailableModels: listAvailableModelsProcedure }),
  }),
});

export const handleTRPCRequest = createTRPCRouteHandler(
  createCallerFactory(organizationSettingsRouter)
);
