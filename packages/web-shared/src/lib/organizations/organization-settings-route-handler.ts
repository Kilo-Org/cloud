import { createCallerFactory, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { createTRPCRouteHandler } from '@kilocode/web-shared/lib/trpc/route-handler';
import { listAvailableModelsProcedure } from '@kilocode/web-shared/routers/organizations/organization-available-models-procedure';

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
