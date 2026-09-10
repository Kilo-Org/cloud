const mockGetTriageTicketById = jest.fn();

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  isResourceTokenIssuanceEnabled: () => true,
}));

import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentWorkflowToken: jest.fn(() => 'workflow-token'),
  TOKEN_EXPIRY: { default: 3600 },
}));

jest.mock('../db/triage-tickets', () => ({
  getTriageTicketById: (...args: unknown[]) => mockGetTriageTicketById(...args),
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { prepareTriagePayload } from './prepare-triage-payload';
import { generateCloudAgentWorkflowToken } from '@/lib/tokens';

const mockGenerateCloudAgentWorkflowToken = jest.mocked(generateCloudAgentWorkflowToken);

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

afterEach(async () => {
  await db.delete(kilocode_users).where(eq(kilocode_users.id, 'user-1'));
});

beforeEach(async () => {
  await insertTestUser({ id: 'user-1', api_token_pepper: null });
  jest.clearAllMocks();
  mockGetTriageTicketById.mockResolvedValue({
    repo_full_name: 'kilo/repo',
    issue_number: 42,
    issue_title: 'Triage it',
    issue_body: 'Please triage',
  });
});

describe('prepareTriagePayload workflow token ownership', () => {
  it.each([
    [{ type: 'org', id: organizationId, userId: 'user-1' }, organizationId],
    [{ type: 'user', id: 'user-1', userId: 'user-1' }, undefined],
  ] as const)(
    'passes the exact owner organization or undefined',
    async (owner, expectedOrganizationId) => {
      await prepareTriagePayload({
        ticketId: 'ticket-1',
        owner,
        agentConfig: {
          config: { enabled_for_issues: true, repository_selection_mode: 'all' },
        },
      });

      const [persisted] = await db
        .select()
        .from(kilocode_users)
        .where(eq(kilocode_users.id, 'user-1'));
      expect(persisted.api_token_pepper).toBe(null);
      expect(mockGenerateCloudAgentWorkflowToken).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1', api_token_pepper: persisted.api_token_pepper }),
        expect.objectContaining({ organizationId: expectedOrganizationId })
      );
    }
  );
});
