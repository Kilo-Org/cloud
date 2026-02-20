import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import {
  getAgentConfigForOwner,
  upsertAgentConfigForOwner,
  setAgentEnabledForOwner,
} from '@/lib/agent-config/db/agent-configs';
import { fetchGitHubRepositoriesForUser } from '@/lib/cloud-agent/github-integration-helpers';
import { createAutoTriageRouter } from '@/lib/auto-triage/application/routers/shared-router-factory';

const sharedHandlers = createAutoTriageRouter({
  ownerResolver: async ctx => {
    return {
      type: 'user',
      id: ctx.user.id,
      userId: ctx.user.id,
    };
  },

  // No audit logger for personal users
  auditLogger: undefined,

  integrationGetter: async owner => {
    return await getIntegrationForOwner(owner, 'github');
  },

  repositoryFetcher: async owner => {
    if (owner.type !== 'user') {
      return {
        integrationInstalled: false,
        repositories: [],
        errorMessage: 'Invalid owner type',
      };
    }
    return await fetchGitHubRepositoriesForUser(owner.id);
  },

  agentConfigGetter: async (owner, agentType, platform) => {
    return await getAgentConfigForOwner(owner, agentType, platform);
  },

  agentConfigUpserter: async ({ owner, agentType, platform, config, createdBy }) => {
    await upsertAgentConfigForOwner({
      owner,
      agentType,
      platform,
      config,
      createdBy,
    });
  },

  agentEnabledSetter: async (owner, agentType, platform, isEnabled) => {
    await setAgentEnabledForOwner(owner, agentType, platform, isEnabled);
  },

  ticketOwnershipVerifier: (ticket, owner) => {
    if (owner.type !== 'user') return false;
    return ticket.owned_by_user_id === owner.id;
  },
});

export const personalAutoTriageRouter = createTRPCRouter({
  getGitHubStatus: baseProcedure.query(sharedHandlers.getGitHubStatus),
  listGitHubRepositories: baseProcedure.query(sharedHandlers.listGitHubRepositories),
  getAutoTriageConfig: baseProcedure.query(sharedHandlers.getAutoTriageConfig),
  saveAutoTriageConfig: baseProcedure
    .input(sharedHandlers.saveAutoTriageConfig.inputSchema)
    .mutation(sharedHandlers.saveAutoTriageConfig.handler),
  toggleAutoTriageAgent: baseProcedure
    .input(sharedHandlers.toggleAutoTriageAgent.inputSchema)
    .mutation(sharedHandlers.toggleAutoTriageAgent.handler),
  retryTicket: baseProcedure
    .input(sharedHandlers.retryTicket.inputSchema)
    .mutation(sharedHandlers.retryTicket.handler),
  interruptTicket: baseProcedure
    .input(sharedHandlers.interruptTicket.inputSchema)
    .mutation(sharedHandlers.interruptTicket.handler),
  listTickets: baseProcedure
    .input(sharedHandlers.listTickets.inputSchema)
    .query(sharedHandlers.listTickets.handler),
});
