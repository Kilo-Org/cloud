process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import jwt from 'jsonwebtoken';
import { NextResponse } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  admin_action_audit_logs,
  cliSessions,
  kilocode_users,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));

const auth = jest.mocked(getUserFromAuth);

const PERSONAL_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PERSONAL_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_33333333';
const ORGANIZATION_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const ORGANIZATION_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_44444444';
const DEPARTED_SESSION_ID = '55555555-5555-4555-8555-555555555555';
const DEPARTED_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_55555555';
const STAFF_OUTSIDER_SESSION_ID = '66666666-6666-4666-8666-666666666666';
const STAFF_OUTSIDER_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_66666666';
const STAFF_MEMBER_SESSION_ID = '77777777-7777-4777-8777-777777777777';
const STAFF_MEMBER_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_77777777';

type StreamTicketClaims = {
  type: string;
  userId: string;
  kiloSessionId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  nonce?: string;
};

let owner: User;
let member: User;
let departed: User;
let staffOutsider: User;
let staffMember: User;
let organization: Organization;

function postTicket(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost:3000/api/cloud-agent/sessions/stream-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function claimsOf(body: { ticket: string }): StreamTicketClaims {
  return jwt.verify(body.ticket, NEXTAUTH_SECRET, {
    audience: 'cloud-agent-stream',
  }) as unknown as StreamTicketClaims;
}

function signInAs(user: User) {
  auth.mockResolvedValue({ user, authFailedResponse: null });
}

describe('POST /api/cloud-agent/sessions/stream-ticket', () => {
  beforeAll(async () => {
    [owner, member, departed, staffOutsider, staffMember] = await Promise.all([
      insertTestUser({ google_user_email: 'stream-ticket-owner@example.com' }),
      insertTestUser({ google_user_email: 'stream-ticket-member@example.com' }),
      insertTestUser({ google_user_email: 'stream-ticket-departed@example.com' }),
      insertTestUser({
        google_user_email: 'stream-ticket-staff-outsider@example.com',
        is_admin: true,
      }),
      insertTestUser({
        google_user_email: 'stream-ticket-staff-member@example.com',
        is_admin: true,
      }),
    ]);

    [organization] = await db
      .insert(organizations)
      .values({
        name: 'Stream Ticket Organization',
        created_by_kilo_user_id: owner.id,
      })
      .returning();

    await db.insert(organization_memberships).values([
      { organization_id: organization.id, kilo_user_id: owner.id, role: 'owner' },
      { organization_id: organization.id, kilo_user_id: member.id, role: 'member' },
    ]);
    await addUserToOrganization(organization.id, staffMember.id, 'member');
  });

  beforeEach(async () => {
    auth.mockReset();

    await db.insert(cliSessions).values([
      {
        session_id: PERSONAL_SESSION_ID,
        kilo_user_id: owner.id,
        title: 'Stream ticket personal session',
        created_on_platform: 'cli',
        cloud_agent_session_id: PERSONAL_CLOUD_AGENT_SESSION_ID,
      },
      {
        session_id: ORGANIZATION_SESSION_ID,
        kilo_user_id: owner.id,
        title: 'Stream ticket organization session',
        created_on_platform: 'cli',
        cloud_agent_session_id: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
        organization_id: organization.id,
      },
      {
        session_id: DEPARTED_SESSION_ID,
        kilo_user_id: departed.id,
        title: 'Stream ticket departed member session',
        created_on_platform: 'cli',
        cloud_agent_session_id: DEPARTED_CLOUD_AGENT_SESSION_ID,
        organization_id: organization.id,
      },
      {
        session_id: STAFF_OUTSIDER_SESSION_ID,
        kilo_user_id: staffOutsider.id,
        title: 'Stream ticket staff outsider session',
        created_on_platform: 'cli',
        cloud_agent_session_id: STAFF_OUTSIDER_CLOUD_AGENT_SESSION_ID,
        organization_id: organization.id,
      },
      {
        session_id: STAFF_MEMBER_SESSION_ID,
        kilo_user_id: staffMember.id,
        title: 'Stream ticket staff member session',
        created_on_platform: 'cli',
        cloud_agent_session_id: STAFF_MEMBER_CLOUD_AGENT_SESSION_ID,
        organization_id: organization.id,
      },
    ]);
  });

  afterEach(async () => {
    await db
      .delete(cliSessions)
      .where(
        inArray(cliSessions.session_id, [
          PERSONAL_SESSION_ID,
          ORGANIZATION_SESSION_ID,
          DEPARTED_SESSION_ID,
          STAFF_OUTSIDER_SESSION_ID,
          STAFF_MEMBER_SESSION_ID,
        ])
      );
  });

  afterAll(async () => {
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, [organization.id]));
    await db.delete(organizations).where(inArray(organizations.id, [organization.id]));
  });

  it('issues a personal ticket without an organization claim', async () => {
    signInAs(owner);

    const response = await postTicket({ cloudAgentSessionId: PERSONAL_CLOUD_AGENT_SESSION_ID });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ticket: string; expiresAt: number };
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const claims = claimsOf(body);
    expect(claims).toMatchObject({
      type: 'stream_ticket',
      userId: owner.id,
      kiloSessionId: PERSONAL_SESSION_ID,
      cloudAgentSessionId: PERSONAL_CLOUD_AGENT_SESSION_ID,
    });
    expect(claims.organizationId).toBeUndefined();
    expect(claims.nonce).toEqual(expect.any(String));
  });

  it('issues an organization ticket to a current member in organization scope', async () => {
    signInAs(member);

    const response = await postTicket({
      cloudAgentSessionId: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
      organizationId: organization.id,
    });

    expect(response.status).toBe(200);
    const claims = claimsOf((await response.json()) as { ticket: string });
    expect(claims).toMatchObject({
      type: 'stream_ticket',
      userId: member.id,
      kiloSessionId: ORGANIZATION_SESSION_ID,
      cloudAgentSessionId: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
      organizationId: organization.id,
    });
  });

  it('requires the organization context for an organization session', async () => {
    signInAs(owner);

    const response = await postTicket({
      cloudAgentSessionId: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Session not found or access denied',
    });
  });

  it('requires a current membership for an organization session', async () => {
    signInAs(departed);

    const personalScope = await postTicket({
      cloudAgentSessionId: DEPARTED_CLOUD_AGENT_SESSION_ID,
    });
    expect(personalScope.status).toBe(403);

    const organizationScope = await postTicket({
      cloudAgentSessionId: DEPARTED_CLOUD_AGENT_SESSION_ID,
      organizationId: organization.id,
    });
    expect(organizationScope.status).toBe(401);
    expect((await organizationScope.json()) as Record<string, unknown>).not.toHaveProperty(
      'ticket'
    );
  });

  it('refuses organization scope to staff without a membership', async () => {
    signInAs(staffOutsider);

    const response = await postTicket({
      cloudAgentSessionId: STAFF_OUTSIDER_CLOUD_AGENT_SESSION_ID,
      organizationId: organization.id,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'You do not have access to this organization',
    });
  });

  it('issues an organization ticket to staff who hold a real membership', async () => {
    signInAs(staffMember);

    const response = await postTicket({
      cloudAgentSessionId: STAFF_MEMBER_CLOUD_AGENT_SESSION_ID,
      organizationId: organization.id,
    });

    expect(response.status).toBe(200);
    expect(claimsOf((await response.json()) as { ticket: string })).toMatchObject({
      userId: staffMember.id,
      kiloSessionId: STAFF_MEMBER_SESSION_ID,
      organizationId: organization.id,
    });
  });

  it('requires the creator for a personal session', async () => {
    signInAs(member);

    const response = await postTicket({ cloudAgentSessionId: PERSONAL_CLOUD_AGENT_SESSION_ID });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Session not found or access denied',
    });
  });

  it('refuses a Kilo admin outside the organization even with support access off, and records no admin row', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const previousSupportAccess = process.env.SUPPORT_ACCESS_ENABLED;
    process.env.SUPPORT_ACCESS_ENABLED = 'false';
    signInAs(admin);

    try {
      const refused = await postTicket({
        cloudAgentSessionId: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
        organizationId: organization.id,
      });
      expect(refused.status).toBe(401);
      expect((await refused.json()) as Record<string, unknown>).not.toHaveProperty('ticket');

      // A stream ticket has no admin bypass, so there is no elevated write to record.
      const rows = await db
        .select()
        .from(admin_action_audit_logs)
        .where(eq(admin_action_audit_logs.actor_id, admin.id));
      expect(rows).toEqual([]);
    } finally {
      if (previousSupportAccess === undefined) delete process.env.SUPPORT_ACCESS_ENABLED;
      else process.env.SUPPORT_ACCESS_ENABLED = previousSupportAccess;
      await db
        .delete(admin_action_audit_logs)
        .where(eq(admin_action_audit_logs.actor_id, admin.id));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, admin.id));
    }
  });

  it('returns the authentication failure response unchanged', async () => {
    const authFailedResponse = NextResponse.json<FailureResult<string>>(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
    auth.mockResolvedValue({ user: null, authFailedResponse, credentialsRejected: true });

    expect(await postTicket({ cloudAgentSessionId: PERSONAL_CLOUD_AGENT_SESSION_ID })).toBe(
      authFailedResponse
    );
  });
});
