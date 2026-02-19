import { createTRPCRouter } from '@/lib/trpc/init';
import { organizationMemberProcedure, organizationOwnerProcedure } from './utils';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import {
  getAgentConfig,
  upsertAgentConfig,
  setAgentEnabled,
} from '@/lib/agent-config/db/agent-configs';
import { fetchGitHubRepositoriesForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import { createAutoTriageRouter } from '@/lib/auto-triage/application/routers/shared-router-factory';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';

const sharedHandlers = createAutoTriageRouter({
  ownerResolver: async (ctx, input) => {
    // Extract organizationId from input (added by organizationMemberProcedure)
    const typedInput = input as { organizationId: string };
    return {
      type: 'org',
      id: typedInput.organizationId,
      userId: ctx.user.id,
    };
  },

  auditLogger: async ({ owner, ctx, message }) => {
    if (owner.type !== 'org') return;
    await createAuditLog({
      organization_id: owner.id,
      action: 'organization.settings.change',
      actor_id: ctx.user.id,
      actor_email: ctx.user.google_user_email,
      actor_name: ctx.user.google_user_name,
      message,
    });
  },

  integrationGetter: async owner => {
    if (owner.type !== 'org') return null;
    return await getIntegrationForOrganization(owner.id, 'github');
  },

  repositoryFetcher: async owner => {
    if (owner.type !== 'org') {
      return {
        integrationInstalled: false,
        repositories: [],
        errorMessage: 'Invalid owner type',
      };
    }
    return await fetchGitHubRepositoriesForOrganization(owner.id);
  },

  agentConfigGetter: async (owner, agentType, platform) => {
    if (owner.type !== 'org') return null;
    return await getAgentConfig(owner.id, agentType, platform);
  },

  agentConfigUpserter: async ({ owner, agentType, platform, config, createdBy }) => {
    if (owner.type !== 'org') return;
    await upsertAgentConfig({
      organizationId: owner.id,
      agentType,
      platform,
      config,
      createdBy,
    });
  },

  agentEnabledSetter: async (owner, agentType, platform, isEnabled) => {
    if (owner.type !== 'org') return;

    // Ensure bot user exists when enabling auto-triage for organizations
    if (isEnabled) {
      await ensureBotUserForOrg(owner.id, 'auto-triage');
    }

    await setAgentEnabled(owner.id, agentType, platform, isEnabled);
  },

  ticketOwnershipVerifier: (ticket, owner) => {
    if (owner.type !== 'org') return false;
    return ticket.owned_by_organization_id === owner.id;
  },
});

export const organizationAutoTriageRouter = createTRPCRouter({
  getGitHubStatus: organizationMemberProcedure.query(sharedHandlers.getGitHubStatus),
  listGitHubRepositories: organizationMemberProcedure.query(sharedHandlers.listGitHubRepositories),
  getAutoTriageConfig: organizationMemberProcedure.query(sharedHandlers.getAutoTriageConfig),
  saveAutoTriageConfig: organizationOwnerProcedure
    .input(sharedHandlers.saveAutoTriageConfig.inputSchema)
    .mutation(sharedHandlers.saveAutoTriageConfig.handler),
  toggleAutoTriageAgent: organizationOwnerProcedure
    .input(sharedHandlers.toggleAutoTriageAgent.inputSchema)
    .mutation(sharedHandlers.toggleAutoTriageAgent.handler),
  retryTicket: organizationMemberProcedure
    .input(sharedHandlers.retryTicket.inputSchema)
    .mutation(sharedHandlers.retryTicket.handler),
  interruptTicket: organizationMemberProcedure
    .input(sharedHandlers.interruptTicket.inputSchema)
    .mutation(sharedHandlers.interruptTicket.handler),
  listTickets: organizationMemberProcedure
    .input(sharedHandlers.listTickets.inputSchema)
    .query(sharedHandlers.listTickets.handler),
});
