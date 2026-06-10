import { describe, expect, it, jest, beforeEach, beforeAll } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2, type User, type Organization } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import * as cloudAgentModule from '@/lib/cloud-agent/cloud-agent-client';

describe('organizationCloudAgentRouter.deleteSession', () => {
  let testUser: User;
  let memberUser: User;
  let nonMemberUser: User;
  let testOrganization: Organization;
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
    // Create test users
    testUser = await insertTestUser({
      google_user_email: 'test-org-cloud-agent@example.com',
      google_user_name: 'Org Cloud Agent Test User',
      is_admin: false,
    });

    memberUser = await insertTestUser({
      google_user_email: 'test-org-member@example.com',
      google_user_name: 'Org Member User',
      is_admin: false,
    });

    nonMemberUser = await insertTestUser({
      google_user_email: 'test-org-non-member@example.com',
      google_user_name: 'Non Member User',
      is_admin: false,
    });

    // Create test organization using CRUD helper
    testOrganization = await createOrganization('Test Cloud Agent Organization', testUser.id);

    // Add member user to organization using CRUD helper
    await addUserToOrganization(testOrganization.id, memberUser.id, 'member');
  });

  it('should call CloudAgentClient.deleteSession with correct sessionId', async () => {
    const sessionId = 'agent_12345678-1234-1234-1234-123456789abc';
    deleteSessionSpy.mockResolvedValue({ success: true });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.organizations.cloudAgent.deleteSession({
      organizationId: testOrganization.id,
      sessionId,
    });

    expect(result).toEqual({ success: true });
    expect(deleteSessionSpy).toHaveBeenCalledWith(sessionId);
    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('should return the result from CloudAgentClient', async () => {
    const sessionId = 'agent_abcdef01-2345-6789-abcd-ef0123456789';
    deleteSessionSpy.mockResolvedValue({ success: true });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.organizations.cloudAgent.deleteSession({
      organizationId: testOrganization.id,
      sessionId,
    });

    expect(result).toEqual({ success: true });
  });

  it('should handle errors from CloudAgentClient gracefully', async () => {
    const sessionId = 'agent_11111111-2222-3333-4444-555555555555';
    deleteSessionSpy.mockRejectedValue(new Error('Network error'));

    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.cloudAgent.deleteSession({
        organizationId: testOrganization.id,
        sessionId,
      })
    ).rejects.toThrow('Network error');
  });

  it('should require authentication', async () => {
    // Create a caller without a valid user - this will throw
    await expect(createCallerForUser('non-existent-user-id')).rejects.toThrow();
  });

  it('should validate organization membership', async () => {
    const sessionId = 'agent_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    deleteSessionSpy.mockResolvedValue({ success: true });

    // Non-member user should be rejected
    const caller = await createCallerForUser(nonMemberUser.id);

    await expect(
      caller.organizations.cloudAgent.deleteSession({
        organizationId: testOrganization.id,
        sessionId,
      })
    ).rejects.toThrow('You do not have access to this organization');
  });

  it('should allow organization members to delete sessions', async () => {
    const sessionId = 'agent_ffffffff-ffff-ffff-ffff-ffffffffffff';
    deleteSessionSpy.mockResolvedValue({ success: true });

    // Member user should be allowed
    const caller = await createCallerForUser(memberUser.id);
    const result = await caller.organizations.cloudAgent.deleteSession({
      organizationId: testOrganization.id,
      sessionId,
    });

    expect(result).toEqual({ success: true });
  });

  it('should handle failure response from CloudAgentClient', async () => {
    const sessionId = 'agent_99999999-8888-7777-6666-555555555555';
    deleteSessionSpy.mockResolvedValue({ success: false });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.organizations.cloudAgent.deleteSession({
      organizationId: testOrganization.id,
      sessionId,
    });

    expect(result).toEqual({ success: false });
  });
});

describe('organizationCloudAgentNextRouter.refreshTerminalTicket', () => {
  const organizationSessionId = 'ses_terminal_ticket_org_owned';
  const personalSessionId = 'ses_terminal_ticket_org_personal';
  const organizationCloudAgentSessionId = 'agent_terminal_ticket_org_owned';
  const personalCloudAgentSessionId = 'agent_terminal_ticket_org_personal';
  let testUser: User;
  let testOrganization: Organization;

  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: 'terminal-ticket-org-owner@example.com',
      google_user_name: 'Terminal Ticket Org Owner',
      is_admin: false,
    });
    testOrganization = await createOrganization('Terminal Ticket Organization', testUser.id);

    await db.insert(cli_sessions_v2).values([
      {
        session_id: organizationSessionId,
        kilo_user_id: testUser.id,
        organization_id: testOrganization.id,
        cloud_agent_session_id: organizationCloudAgentSessionId,
        created_on_platform: 'cloud-agent-web',
      },
      {
        session_id: personalSessionId,
        kilo_user_id: testUser.id,
        cloud_agent_session_id: personalCloudAgentSessionId,
        created_on_platform: 'cloud-agent-web',
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, organizationSessionId));
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, personalSessionId));
  });

  it('issues a terminal ticket for a session owned by the organization', async () => {
    const caller = await createCallerForUser(testUser.id);

    const result = await caller.organizations.cloudAgentNext.refreshTerminalTicket({
      organizationId: testOrganization.id,
      cloudAgentSessionId: organizationCloudAgentSessionId,
      ptyId: 'pty_org_owned',
    });

    expect(result.ticket).toEqual(expect.any(String));
    expect(result.wsUrl).toContain(`cloudAgentSessionId=${organizationCloudAgentSessionId}`);
  });

  it('rejects terminal ticket refresh for a session outside the organization', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.cloudAgentNext.refreshTerminalTicket({
        organizationId: testOrganization.id,
        cloudAgentSessionId: personalCloudAgentSessionId,
        ptyId: 'pty_org_other',
      })
    ).rejects.toThrow('Organization does not own this session');
  });

  it('rejects terminal creation for a session outside the organization', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.cloudAgentNext.createTerminal({
        organizationId: testOrganization.id,
        cloudAgentSessionId: personalCloudAgentSessionId,
      })
    ).rejects.toThrow('Organization does not own this session');
  });

  it('rejects terminal resizing for a session outside the organization', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.cloudAgentNext.resizeTerminal({
        organizationId: testOrganization.id,
        cloudAgentSessionId: personalCloudAgentSessionId,
        ptyId: 'pty_org_other',
        cols: 120,
        rows: 32,
      })
    ).rejects.toThrow('Organization does not own this session');
  });

  it('rejects terminal closure for a session outside the organization', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.organizations.cloudAgentNext.closeTerminal({
        organizationId: testOrganization.id,
        cloudAgentSessionId: personalCloudAgentSessionId,
        ptyId: 'pty_org_other',
      })
    ).rejects.toThrow('Organization does not own this session');
  });
});
