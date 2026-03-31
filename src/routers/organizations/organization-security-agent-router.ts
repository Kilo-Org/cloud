import { createTRPCRouter } from '@/lib/trpc/init';
import {
  organizationMemberProcedure,
  organizationMemberMutationProcedure,
  organizationBillingMutationProcedure,
  OrganizationIdInputSchema,
} from './utils';

import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { getGitHubTokenForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import { createSecurityAgentHandlers } from '@/lib/security-agent/router/shared-handlers';

const handlers = createSecurityAgentHandlers<{ organizationId: string }>({
  resolveOwner: (ctx, input) => ({
    type: 'org',
    id: input.organizationId,
    userId: ctx.user.id,
  }),
  resolveSecurityOwner: (_ctx, input) => ({
    organizationId: input.organizationId,
  }),
  resolveResourceId: (_ctx, input) => input.organizationId,
  verifyFindingOwnership: (finding, _ctx, input) =>
    finding.owned_by_organization_id === input.organizationId,
  getIntegration: async (_ctx, input) =>
    await getIntegrationForOrganization(input.organizationId, 'github'),
  getGitHubToken: async (_ctx, input) =>
    (await getGitHubTokenForOrganization(input.organizationId)) ?? null,
  trackingExtras: (_ctx, input) => ({
    organizationId: input.organizationId,
  }),
});

export const organizationSecurityAgentRouter = createTRPCRouter({
  getPermissionStatus: organizationMemberProcedure.query(handlers.getPermissionStatus),
  getConfig: organizationMemberProcedure.query(handlers.getConfig),
  saveConfig: organizationBillingMutationProcedure
    .input(OrganizationIdInputSchema.merge(handlers.saveConfig.inputSchema))
    .mutation(handlers.saveConfig.handler),
  setEnabled: organizationBillingMutationProcedure
    .input(OrganizationIdInputSchema.merge(handlers.setEnabled.inputSchema))
    .mutation(handlers.setEnabled.handler),
  getRepositories: organizationMemberProcedure.query(handlers.getRepositories),
  listFindings: organizationMemberProcedure
    .input(OrganizationIdInputSchema.merge(handlers.listFindings.inputSchema))
    .query(handlers.listFindings.handler),
  getFinding: organizationMemberProcedure
    .input(OrganizationIdInputSchema.merge(handlers.getFinding.inputSchema))
    .query(handlers.getFinding.handler),
  getStats: organizationMemberProcedure.query(handlers.getStats),
  getDashboardStats: organizationMemberProcedure
    .input(OrganizationIdInputSchema.merge(handlers.getDashboardStats.inputSchema))
    .query(handlers.getDashboardStats.handler),
  getLastSyncTime: organizationMemberProcedure
    .input(OrganizationIdInputSchema.merge(handlers.getLastSyncTime.inputSchema))
    .query(handlers.getLastSyncTime.handler),
  triggerSync: organizationMemberMutationProcedure
    .input(OrganizationIdInputSchema.merge(handlers.triggerSync.inputSchema))
    .mutation(handlers.triggerSync.handler),
  dismissFinding: organizationBillingMutationProcedure
    .input(OrganizationIdInputSchema.merge(handlers.dismissFinding.inputSchema))
    .mutation(handlers.dismissFinding.handler),
  startAnalysis: organizationMemberMutationProcedure
    .input(OrganizationIdInputSchema.merge(handlers.startAnalysis.inputSchema))
    .mutation(handlers.startAnalysis.handler),
  getAnalysis: organizationMemberProcedure
    .input(OrganizationIdInputSchema.merge(handlers.getAnalysis.inputSchema))
    .query(handlers.getAnalysis.handler),
  getOrphanedRepositories: organizationMemberProcedure.query(handlers.getOrphanedRepositories),
  deleteFindingsByRepository: organizationBillingMutationProcedure
    .input(OrganizationIdInputSchema.merge(handlers.deleteFindingsByRepository.inputSchema))
    .mutation(handlers.deleteFindingsByRepository.handler),
  getAutoDismissEligible: organizationMemberProcedure.query(handlers.getAutoDismissEligible),
  autoDismissEligible: organizationBillingMutationProcedure.mutation(handlers.autoDismissEligible),
});
