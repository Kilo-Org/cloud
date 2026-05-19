import { describe, expect, it, jest, beforeEach, beforeAll } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import * as cloudAgentModule from '@/lib/cloud-agent/cloud-agent-client';

describe('cloudAgentRouter.deleteSession', () => {
  let testUser: User;
  let deleteSessionSpy: jest.SpiedFunction<
    typeof cloudAgentModule.CloudAgentClient.prototype.deleteSession
  >;

  beforeEach(() => {
    // Spy on the deleteSession method
    deleteSessionSpy = jest.spyOn(cloudAgentModule.CloudAgentClient.prototype, 'deleteSession');
  });

  afterEach(() => {
    // Restore after each test
    deleteSessionSpy.mockRestore();
  });

  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: 'test-cloud-agent@example.com',
      google_user_name: 'Cloud Agent Test User',
      is_admin: false,
    });
  });

  it('should call CloudAgentClient.deleteSession with correct sessionId', async () => {
    const sessionId = 'agent_12345678-1234-1234-1234-123456789abc';
    deleteSessionSpy.mockResolvedValue({ success: true });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.cloudAgent.deleteSession({ sessionId });

    expect(result).toEqual({ success: true });
    expect(deleteSessionSpy).toHaveBeenCalledWith(sessionId);
    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('should return the result from CloudAgentClient', async () => {
    const sessionId = 'agent_abcdef01-2345-6789-abcd-ef0123456789';
    deleteSessionSpy.mockResolvedValue({ success: true });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.cloudAgent.deleteSession({ sessionId });

    expect(result).toEqual({ success: true });
  });

  it('should handle errors from CloudAgentClient gracefully', async () => {
    const sessionId = 'agent_11111111-2222-3333-4444-555555555555';
    deleteSessionSpy.mockRejectedValue(new Error('Network error'));

    const caller = await createCallerForUser(testUser.id);

    await expect(caller.cloudAgent.deleteSession({ sessionId })).rejects.toThrow('Network error');
  });

  it('should require authentication', async () => {
    // Create a caller without a valid user - this will throw
    await expect(createCallerForUser('non-existent-user-id')).rejects.toThrow();
  });

  it('should handle failure response from CloudAgentClient', async () => {
    const sessionId = 'agent_00000000-0000-0000-0000-000000000000';
    deleteSessionSpy.mockResolvedValue({ success: false });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.cloudAgent.deleteSession({ sessionId });

    expect(result).toEqual({ success: false });
  });
});

describe('cloudAgentNextRouter.refreshTerminalTicket', () => {
  const ownedSessionId = 'ses_terminal_ticket_personal_owned';
  const otherSessionId = 'ses_terminal_ticket_personal_other';
  const ownedCloudAgentSessionId = 'agent_terminal_ticket_personal_owned';
  const otherCloudAgentSessionId = 'agent_terminal_ticket_personal_other';
  let testUser: User;
  let otherUser: User;

  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: 'terminal-ticket-personal-owner@example.com',
      google_user_name: 'Terminal Ticket Personal Owner',
      is_admin: false,
    });
    otherUser = await insertTestUser({
      google_user_email: 'terminal-ticket-personal-other@example.com',
      google_user_name: 'Terminal Ticket Personal Other',
      is_admin: false,
    });

    await db.insert(cli_sessions_v2).values([
      {
        session_id: ownedSessionId,
        kilo_user_id: testUser.id,
        cloud_agent_session_id: ownedCloudAgentSessionId,
        created_on_platform: 'cloud-agent-web',
      },
      {
        session_id: otherSessionId,
        kilo_user_id: otherUser.id,
        cloud_agent_session_id: otherCloudAgentSessionId,
        created_on_platform: 'cloud-agent-web',
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, ownedSessionId));
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, otherSessionId));
  });

  it('issues a terminal ticket for a session owned by the caller', async () => {
    const caller = await createCallerForUser(testUser.id);

    const result = await caller.cloudAgentNext.refreshTerminalTicket({
      cloudAgentSessionId: ownedCloudAgentSessionId,
      ptyId: 'pty_personal_owned',
    });

    expect(result.ticket).toEqual(expect.any(String));
    expect(result.wsUrl).toContain(`cloudAgentSessionId=${ownedCloudAgentSessionId}`);
  });

  it('rejects terminal ticket refresh for a session owned by another user', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.cloudAgentNext.refreshTerminalTicket({
        cloudAgentSessionId: otherCloudAgentSessionId,
        ptyId: 'pty_personal_other',
      })
    ).rejects.toThrow('Session not found or access denied');
  });

  it('rejects terminal creation for a session owned by another user', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.cloudAgentNext.createTerminal({
        cloudAgentSessionId: otherCloudAgentSessionId,
      })
    ).rejects.toThrow('Session not found or access denied');
  });

  it('rejects terminal resizing for a session owned by another user', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.cloudAgentNext.resizeTerminal({
        cloudAgentSessionId: otherCloudAgentSessionId,
        ptyId: 'pty_personal_other',
        cols: 120,
        rows: 32,
      })
    ).rejects.toThrow('Session not found or access denied');
  });

  it('rejects terminal closure for a session owned by another user', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.cloudAgentNext.closeTerminal({
        cloudAgentSessionId: otherCloudAgentSessionId,
        ptyId: 'pty_personal_other',
      })
    ).rejects.toThrow('Session not found or access denied');
  });
});
