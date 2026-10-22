import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import { createCallerForUser } from '@/routers/test-utils';
import { expectNonExchangeableSystemToken } from '@/tests/helpers/system-token.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { cli_sessions_v2, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const mockGetSession = jest.fn();
const mockDeleteCloudAgentSession = jest.fn();
const mockFetchSessionMessagesPage = jest.fn();
const mockDeleteSessionIngest = jest.fn();

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null) },
}));

// This suite proves a system token cannot be exchanged. A real device proof
// needs a live App Attest or Play Integrity verdict, so only the verifier is
// stubbed; the helper sends a complete proof shape.
jest.mock('@/lib/auth/native-admission', () => ({
  ...jest.requireActual('@/lib/auth/native-admission'),
  verifyAdmissionAsync: async () => ({ ok: true, platform: 'android', keyId: '' }),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    getSession: mockGetSession,
    getPreparationAttempts: jest.fn(async () => []),
    deleteSession: mockDeleteCloudAgentSession,
  })),
}));

jest.mock('@/lib/session-ingest-client', () => ({
  fetchSessionMessagesPage: (...args: unknown[]) => mockFetchSessionMessagesPage(...args),
  deleteSession: (...args: unknown[]) => mockDeleteSessionIngest(...args),
}));

const mockedCreateCloudAgentNextClient = createCloudAgentNextClient as jest.MockedFunction<
  typeof createCloudAgentNextClient
>;

describe('cli-sessions-v2 cloud-agent token source', () => {
  let user: User;

  const sessions = {
    page: {
      sessionId: 'ses_token_source_page_123456789',
      cloudAgentSessionId: 'agent_11111111-1111-4111-8111-111111111111',
    },
    runtime: {
      sessionId: 'ses_token_source_runtime_1234567',
      cloudAgentSessionId: 'agent_22222222-2222-4222-8222-222222222222',
    },
    delete: {
      sessionId: 'ses_token_source_delete_1234567',
      cloudAgentSessionId: 'agent_33333333-3333-4333-8333-333333333333',
    },
  };

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'cli-sessions-v2-token-source@example.com',
      google_user_name: 'CLI Sessions V2 Token Source User',
    });
  });

  beforeEach(async () => {
    mockedCreateCloudAgentNextClient.mockClear();
    mockGetSession.mockReset();
    mockDeleteCloudAgentSession.mockReset().mockResolvedValue({ success: true });
    mockFetchSessionMessagesPage.mockReset().mockResolvedValue({
      kiloSessionId: sessions.page.sessionId,
      history: { messages: [], nextCursor: null, omittedItemCount: 0 },
    });
    mockDeleteSessionIngest.mockReset().mockResolvedValue(undefined);

    await db.insert(cli_sessions_v2).values(
      Object.values(sessions).map(session => ({
        session_id: session.sessionId,
        cloud_agent_session_id: session.cloudAgentSessionId,
        kilo_user_id: user.id,
        created_on_platform: 'cloud-agent',
      }))
    );
  });

  afterEach(async () => {
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.kilo_user_id, user.id));
  });

  it('uses non-exchangeable tokens for watermark, runtime, and session deletion', async () => {
    mockGetSession.mockResolvedValue({
      sessionId: sessions.runtime.cloudAgentSessionId,
      userId: user.id,
      execution: null,
      timestamp: 1,
      version: 1,
    });

    const caller = await createCallerForUser(user.id);

    await caller.cliSessionsV2.getSessionMessagesPage({
      session_id: sessions.page.sessionId,
    });
    await caller.cliSessionsV2.getWithRuntimeState({
      session_id: sessions.runtime.sessionId,
    });
    await caller.cliSessionsV2.delete({ session_id: sessions.delete.sessionId });

    expect(mockGetSession).toHaveBeenCalledWith(sessions.page.cloudAgentSessionId);
    expect(mockGetSession).toHaveBeenCalledWith(sessions.runtime.cloudAgentSessionId);
    expect(mockDeleteCloudAgentSession).toHaveBeenCalledWith(sessions.delete.cloudAgentSessionId);
    expect(mockFetchSessionMessagesPage).toHaveBeenCalledWith(sessions.page.sessionId, user.id, {
      limit: 50,
    });
    expect(mockDeleteSessionIngest).toHaveBeenCalledWith(sessions.delete.sessionId, user.id);
    expect(mockedCreateCloudAgentNextClient).toHaveBeenCalledTimes(3);

    await Promise.all(
      mockedCreateCloudAgentNextClient.mock.calls.map(([token]) =>
        expectNonExchangeableSystemToken(token, user, 'cloud-agent')
      )
    );
  });
});
