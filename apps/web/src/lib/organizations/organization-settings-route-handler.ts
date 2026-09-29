import { createCallerFactory, createTRPCRouter } from '@/lib/trpc/init';
import { createTRPCRouteHandler } from '@/lib/trpc/route-handler';
import { organizationsSettingsRouter } from '@/routers/organizations/organization-settings-router';

// Mounts the settings router at its root-router path, so callers keep using
// `caller.organizations.settings.*` without importing every router.
const organizationSettingsRouter = createTRPCRouter({
  organizations: createTRPCRouter({ settings: organizationsSettingsRouter }),
});

export const handleTRPCRequest = createTRPCRouteHandler(
  createCallerFactory(organizationSettingsRouter)
);
