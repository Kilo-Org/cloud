const mockTryDispatchPendingTickets = jest.fn();

jest.mock('@/lib/auto-triage/db/triage-tickets', () => ({
  listTriageTickets: jest.fn(),
  countTriageTickets: jest.fn(),
  getTriageTicketById: jest.fn(),
  resetTriageTicketForRetry: jest.fn(),
  interruptTriageTicket: jest.fn(),
}));
jest.mock('@/lib/auto-triage/dispatch/dispatch-pending-tickets', () => ({
  tryDispatchPendingTickets: (...args: unknown[]) => mockTryDispatchPendingTickets(...args),
}));
jest.mock('@/lib/bot-users/bot-user-service', () => ({
  ensureBotUserForOrg: jest.fn(),
}));

import { createAutoTriageRouter } from './shared-router-factory';

describe('Auto Triage repository configuration', () => {
  it('returns repositories from every installation with provenance intact', async () => {
    const repositories = [
      {
        id: 1,
        name: 'api',
        fullName: 'acme-core/api',
        private: true,
        platformIntegrationId: 'integration-core',
        platformAccountLogin: 'acme-core',
      },
      {
        id: 2,
        name: 'scanner',
        fullName: 'acme-security/scanner',
        private: true,
        platformIntegrationId: 'integration-security',
        platformAccountLogin: 'acme-security',
      },
    ];
    const repositoryFetcher = jest.fn().mockResolvedValue({
      integrationInstalled: true,
      repositories,
    });
    const handlers = createAutoTriageRouter({
      ownerResolver: async () => ({ type: 'org', id: crypto.randomUUID(), userId: 'user-1' }),
      integrationGetter: async () => null,
      repositoryFetcher,
      agentConfigGetter: async () => null,
      agentConfigUpserter: async () => undefined,
      agentEnabledSetter: async () => undefined,
      ticketOwnershipVerifier: () => true,
    });

    const result = await handlers.listGitHubRepositories({
      ctx: { user: { id: 'user-1' } } as never,
      input: {},
    });

    expect(result.repositories).toEqual(repositories);
    expect(repositoryFetcher).toHaveBeenCalledTimes(1);
  });
});
