import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { getGitHubTokenForUser } from '@/lib/cloud-agent/github-integration-helpers';
import { createSecurityAgentHandlers } from '@/lib/security-agent/router/shared-handlers';

const handlers = createSecurityAgentHandlers({
  resolveOwner: ctx => ({
    type: 'user',
    id: ctx.user.id,
    userId: ctx.user.id,
  }),
  resolveSecurityOwner: ctx => ({
    userId: ctx.user.id,
  }),
  resolveResourceId: ctx => ctx.user.id,
  verifyFindingOwnership: (finding, ctx) => finding.owned_by_user_id === ctx.user.id,
  getIntegration: async ctx => {
    const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
    return await getIntegrationForOwner(owner, 'github');
  },
  getGitHubToken: async ctx => {
    return (await getGitHubTokenForUser(ctx.user.id)) ?? null;
  },
  trackingExtras: () => ({}),
});

export const securityAgentRouter = createTRPCRouter({
  getPermissionStatus: baseProcedure.query(handlers.getPermissionStatus),
  getConfig: baseProcedure.query(handlers.getConfig),
  saveConfig: baseProcedure
    .input(handlers.saveConfig.inputSchema)
    .mutation(handlers.saveConfig.handler),
  setEnabled: baseProcedure
    .input(handlers.setEnabled.inputSchema)
    .mutation(handlers.setEnabled.handler),
  getRepositories: baseProcedure.query(handlers.getRepositories),
  listFindings: baseProcedure
    .input(handlers.listFindings.inputSchema)
    .query(handlers.listFindings.handler),
  getFinding: baseProcedure
    .input(handlers.getFinding.inputSchema)
    .query(handlers.getFinding.handler),
  getStats: baseProcedure.query(handlers.getStats),
  getDashboardStats: baseProcedure
    .input(handlers.getDashboardStats.inputSchema)
    .query(handlers.getDashboardStats.handler),
  getLastSyncTime: baseProcedure
    .input(handlers.getLastSyncTime.inputSchema)
    .query(handlers.getLastSyncTime.handler),
  triggerSync: baseProcedure
    .input(handlers.triggerSync.inputSchema)
    .mutation(handlers.triggerSync.handler),
  dismissFinding: baseProcedure
    .input(handlers.dismissFinding.inputSchema)
    .mutation(handlers.dismissFinding.handler),
  startAnalysis: baseProcedure
    .input(handlers.startAnalysis.inputSchema)
    .mutation(handlers.startAnalysis.handler),
  getAnalysis: baseProcedure
    .input(handlers.getAnalysis.inputSchema)
    .query(handlers.getAnalysis.handler),
  getOrphanedRepositories: baseProcedure.query(handlers.getOrphanedRepositories),
  deleteFindingsByRepository: baseProcedure
    .input(handlers.deleteFindingsByRepository.inputSchema)
    .mutation(handlers.deleteFindingsByRepository.handler),
  getAutoDismissEligible: baseProcedure.query(handlers.getAutoDismissEligible),
  autoDismissEligible: baseProcedure.mutation(handlers.autoDismissEligible),
});
