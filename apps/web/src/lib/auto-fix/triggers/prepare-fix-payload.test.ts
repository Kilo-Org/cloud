const mockGetFixTicketById = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => [{ id: 'user-1', api_token_pepper: 'pepper' }],
        }),
      }),
    }),
  },
}));

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentWorkflowToken: jest.fn(() => 'workflow-token'),
  TOKEN_EXPIRY: { default: 3600 },
}));

jest.mock('../db/fix-tickets', () => ({
  getFixTicketById: (...args: unknown[]) => mockGetFixTicketById(...args),
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { prepareFixPayload } from './prepare-fix-payload';
import { generateCloudAgentWorkflowToken } from '@/lib/tokens';

const mockGenerateCloudAgentWorkflowToken = jest.mocked(generateCloudAgentWorkflowToken);

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFixTicketById.mockResolvedValue({
    repo_full_name: 'kilo/repo',
    issue_number: 42,
    issue_title: 'Fix it',
    issue_body: 'Please fix',
    trigger_source: 'label',
  });
});

describe('prepareFixPayload workflow token ownership', () => {
  it.each([
    [{ type: 'org', id: organizationId, userId: 'user-1' }, organizationId],
    [{ type: 'user', id: 'user-1', userId: 'user-1' }, undefined],
  ] as const)(
    'passes the exact owner organization or undefined',
    async (owner, expectedOrganizationId) => {
      await prepareFixPayload({
        ticketId: 'ticket-1',
        owner,
        agentConfig: {
          config: { enabled_for_issues: true, repository_selection_mode: 'all' },
        },
      });

      expect(mockGenerateCloudAgentWorkflowToken).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({ organizationId: expectedOrganizationId })
      );
    }
  );
});
