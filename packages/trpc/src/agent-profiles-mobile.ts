import 'server-only';
import { createTRPCRouter } from '@/lib/trpc/init';
import { agentProfilesRouter } from '@/routers/agent-profiles-router';

/**
 * Mobile-scoped agent profiles router. Exposes the profile-management
 * procedures the mobile profiles screens call — the read-side helpers
 * (`list`, `listCombined`, `get`) plus the mutations for creating, editing,
 * deleting, and configuring profiles. Every procedure keeps the server-side
 * `baseProcedure` auth and the per-call `ensureOrganizationAccess` check
 * inside `agentProfilesRouter`; this mount only re-exposes them to the mobile
 * client and adds no server behavior of its own.
 */
export const agentProfilesMobileRouter = createTRPCRouter({
  list: agentProfilesRouter.list,
  listCombined: agentProfilesRouter.listCombined,
  get: agentProfilesRouter.get,
  create: agentProfilesRouter.create,
  update: agentProfilesRouter.update,
  delete: agentProfilesRouter.delete,
  setAsDefault: agentProfilesRouter.setAsDefault,
  clearDefault: agentProfilesRouter.clearDefault,
  setVar: agentProfilesRouter.setVar,
  deleteVar: agentProfilesRouter.deleteVar,
  setCommands: agentProfilesRouter.setCommands,
  createCustomSkill: agentProfilesRouter.createCustomSkill,
  updateSkill: agentProfilesRouter.updateSkill,
  deleteSkill: agentProfilesRouter.deleteSkill,
  setSkillEnabled: agentProfilesRouter.setSkillEnabled,
  createMcp: agentProfilesRouter.createMcp,
  updateMcp: agentProfilesRouter.updateMcp,
  deleteMcp: agentProfilesRouter.deleteMcp,
  setMcpEnabled: agentProfilesRouter.setMcpEnabled,
  createAgent: agentProfilesRouter.createAgent,
  updateAgent: agentProfilesRouter.updateAgent,
  deleteAgent: agentProfilesRouter.deleteAgent,
  createKiloCommand: agentProfilesRouter.createKiloCommand,
  updateKiloCommand: agentProfilesRouter.updateKiloCommand,
  deleteKiloCommand: agentProfilesRouter.deleteKiloCommand,
  setKiloCommandEnabled: agentProfilesRouter.setKiloCommandEnabled,
  reorderKiloCommands: agentProfilesRouter.reorderKiloCommands,
  bindToRepo: agentProfilesRouter.bindToRepo,
  unbindRepo: agentProfilesRouter.unbindRepo,
  listRepoBindings: agentProfilesRouter.listRepoBindings,
});
