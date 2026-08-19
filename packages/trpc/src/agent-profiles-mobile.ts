import 'server-only';
import { createTRPCRouter } from '@/lib/trpc/init';
import { agentProfilesRouter } from '@/routers/agent-profiles-router';

/**
 * Mobile-scoped agent profiles router. Exposes only the read-side procedures
 * the mobile new-session flow needs — `list`, `listCombined`, and `get`. The
 * mutation surface (create/update/delete/...) stays web-only, so the mobile
 * client cannot build a profile editor through this mount.
 */
export const agentProfilesMobileRouter = createTRPCRouter({
  list: agentProfilesRouter.list,
  listCombined: agentProfilesRouter.listCombined,
  get: agentProfilesRouter.get,
});
