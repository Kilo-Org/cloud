const mockGetBlobContent = jest.fn();
const mockFetchSessionSnapshot = jest.fn();

jest.mock('@/lib/r2/cli-sessions', () => ({
  getBlobContent: (...args: unknown[]) => mockGetBlobContent(...args),
}));

jest.mock('@/lib/session-ingest-client', () => ({
  fetchSessionSnapshot: (...args: unknown[]) => mockFetchSessionSnapshot(...args),
}));

import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';

async function insertAdmin(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({ is_admin: true, ...overrides });
}

describe('admin.sessionTraces authorization', () => {
  beforeEach(() => {
    mockGetBlobContent.mockReset();
    mockFetchSessionSnapshot.mockReset();
  });

  test.each([
    [
      'resolveCloudAgentSession',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.resolveCloudAgentSession({
          cloud_agent_session_id: 'agent_not_authorized',
        }),
    ],
    [
      'get',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.get({ session_id: crypto.randomUUID() }),
    ],
    [
      'getMessages',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.getMessages({ session_id: crypto.randomUUID() }),
    ],
    [
      'getApiConversationHistory',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.getApiConversationHistory({ session_id: crypto.randomUUID() }),
    ],
  ] as const)(
    '%s rejects non-admin, ordinary-admin, and superadmin-only callers',
    async (_, call) => {
      const nonAdmin = await insertTestUser();
      const ordinaryAdmin = await insertAdmin();
      const superadmin = await insertAdmin({ is_super_admin: true });

      await expect(call(await createCallerForUser(nonAdmin.id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Admin access required',
      });
      await expect(call(await createCallerForUser(ordinaryAdmin.id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Session viewing access required',
      });
      await expect(call(await createCallerForUser(superadmin.id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Session viewing access required',
      });
      expect(mockGetBlobContent).not.toHaveBeenCalled();
      expect(mockFetchSessionSnapshot).not.toHaveBeenCalled();
    }
  );

  test('rejects valid sensitive resource IDs before external reads', async () => {
    const owner = await insertTestUser();
    const ordinaryAdmin = await insertAdmin();
    const [v1] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: owner.id,
        title: 'Unauthorized support trace',
        ui_messages_blob_url: 'sessions/unauthorized-messages.json',
      })
      .returning();
    if (!v1) throw new Error('Failed to create unauthorized v1 session');
    const v2Id = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({ session_id: v2Id, kilo_user_id: owner.id });

    const caller = await createCallerForUser(ordinaryAdmin.id);
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: v1.session_id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: v2Id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetBlobContent).not.toHaveBeenCalled();
    expect(mockFetchSessionSnapshot).not.toHaveBeenCalled();
  });

  test('a session viewer can resolve and read v1 metadata and blob-backed content', async () => {
    const owner = await insertTestUser();
    const viewer = await insertAdmin({ can_view_sessions: true });
    const cloudAgentSessionId = `agent_${crypto.randomUUID()}`;
    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: owner.id,
        title: 'Support trace',
        cloud_agent_session_id: cloudAgentSessionId,
        ui_messages_blob_url: 'sessions/messages.json',
        api_conversation_history_blob_url: 'sessions/history.json',
      })
      .returning();
    if (!session) throw new Error('Failed to create v1 session');

    const caller = await createCallerForUser(viewer.id);
    mockGetBlobContent
      .mockResolvedValueOnce([{ type: 'user', text: 'hello' }])
      .mockResolvedValueOnce([{ role: 'user', content: 'hello' }]);
    await expect(
      caller.admin.sessionTraces.resolveCloudAgentSession({
        cloud_agent_session_id: cloudAgentSessionId,
      })
    ).resolves.toEqual({ session_id: session.session_id });
    await expect(
      caller.admin.sessionTraces.get({ session_id: session.session_id })
    ).resolves.toMatchObject({ session_id: session.session_id, user: { id: owner.id } });
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: session.session_id })
    ).resolves.toEqual({ messages: [{ type: 'user', text: 'hello' }], format: 'v1' });
    await expect(
      caller.admin.sessionTraces.getApiConversationHistory({ session_id: session.session_id })
    ).resolves.toEqual({ history: [{ role: 'user', content: 'hello' }] });
    expect(mockGetBlobContent).toHaveBeenNthCalledWith(1, 'sessions/messages.json');
    expect(mockGetBlobContent).toHaveBeenNthCalledWith(2, 'sessions/history.json');
  });

  test('a session viewer can resolve and read v2 metadata and messages', async () => {
    const owner = await insertTestUser();
    const viewer = await insertAdmin({ can_view_sessions: true });
    const sessionId = `ses_${crypto.randomUUID()}`;
    const cloudAgentSessionId = `agent_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: owner.id,
      cloud_agent_session_id: cloudAgentSessionId,
    });

    const caller = await createCallerForUser(viewer.id);
    mockFetchSessionSnapshot.mockResolvedValue({
      info: { id: sessionId },
      messages: [{ info: { id: 'message-1', role: 'user' }, parts: [] }],
    });
    await expect(
      caller.admin.sessionTraces.resolveCloudAgentSession({
        cloud_agent_session_id: cloudAgentSessionId,
      })
    ).resolves.toEqual({ session_id: sessionId });
    await expect(caller.admin.sessionTraces.get({ session_id: sessionId })).resolves.toMatchObject({
      session_id: sessionId,
      user: { id: owner.id },
    });
    await expect(
      caller.admin.sessionTraces.getApiConversationHistory({ session_id: sessionId })
    ).resolves.toEqual({ history: null });
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: sessionId })
    ).resolves.toEqual({
      messages: [{ info: { id: 'message-1', role: 'user' }, parts: [] }],
      format: 'v2',
    });
    expect(mockFetchSessionSnapshot).toHaveBeenCalledWith(sessionId, owner.id);
  });
});
