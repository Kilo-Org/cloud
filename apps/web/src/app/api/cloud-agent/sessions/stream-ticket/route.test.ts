process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import jwt from 'jsonwebtoken';
import { NextResponse } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  cliSessions,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));

const auth = jest.mocked(getUserFromAuth);

const PERSONAL_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PERSONAL_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_33333333';
const ORGANIZATION_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const ORGANIZATION_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_44444444';
const DEPARTED_SESSION_ID = '55555555-5555-4555-8555-555555555555';
const DEPARTED_CLOUD_AGENT_SESSION_ID = 'workspace_ticket_55555555';

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
    [owner, member, departed] = await Promise.all([
      insertTestUser({ google_user_email: 'stream-ticket-owner@example.com' }),
      insertTestUser({ google_user_email: 'stream-ticket-member@example.com' }),
      insertTestUser({ google_user_email: 'stream-ticket-departed@example.com' }),
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

  it('refuses an organization session requested in personal scope', async () => {
    signInAs(owner);

    const response = await postTicket({
      cloudAgentSessionId: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Session not found or access denied',
    });
  });

  it('refuses an organization session to a caller without a current membership', async () => {
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

  it("refuses another user's personal session", async () => {
    signInAs(member);

    const response = await postTicket({ cloudAgentSessionId: PERSONAL_CLOUD_AGENT_SESSION_ID });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Session not found or access denied',
    });
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
