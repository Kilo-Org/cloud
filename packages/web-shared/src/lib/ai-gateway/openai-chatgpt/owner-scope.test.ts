jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { openai_chatgpt_connections, organizations } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { getOpenAiChatGptStoredConnection, saveOpenAiChatGptConnection } from './store';
import { getOpenAiChatGptByokModelIds, isOpenAiChatGptEligible } from './routing';
import type { OpenAiChatGptConnection } from './types';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

const REQUESTED_MODEL = 'openai/gpt-5-nano';
const originalPartnerKey = process.env.OPENAI_CHATGPT_API_KEY;

function connection(email: string): OpenAiChatGptConnection {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: 1_800_000_000,
    scope: 'openid profile email offline_access',
    token_type: 'Bearer',
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: `subject-${email}`,
    email,
    connected_at: '2026-09-16T00:00:00.000Z',
    status: 'connected',
  };
}

function responsesRequest(): GatewayRequest {
  return { kind: 'responses', body: { model: REQUESTED_MODEL, input: 'hello' } };
}

describe('openai-chatgpt owner scope (real database)', () => {
  let user: User;
  let otherUser: User;
  let personalEmail: string;
  let orgA: { id: string };
  let orgB: { id: string };

  beforeAll(async () => {
    process.env.OPENAI_CHATGPT_API_KEY = 'partner-project-key';
    user = await insertTestUser({
      google_user_email: `chatgpt-owner-${randomUUID()}@example.com`,
    });
    otherUser = await insertTestUser({
      google_user_email: `chatgpt-other-${randomUUID()}@example.com`,
    });
    orgA = await createTestOrganization(`ChatGPT Org A ${randomUUID()}`, user.id, 0);
    orgB = await createTestOrganization(`ChatGPT Org B ${randomUUID()}`, user.id, 0);

    personalEmail = `personal-${randomUUID()}@example.com`;
    await saveOpenAiChatGptConnection(
      { kiloUserId: user.id, organizationId: null },
      connection(personalEmail),
      user.id
    );
    await saveOpenAiChatGptConnection(
      { kiloUserId: user.id, organizationId: orgA.id },
      connection(`org-a-${randomUUID()}@example.com`),
      user.id
    );
    // A second member of the same organization connects their own account.
    await saveOpenAiChatGptConnection(
      { kiloUserId: otherUser.id, organizationId: orgA.id },
      connection(`org-a-other-${randomUUID()}@example.com`),
      otherUser.id
    );
  });

  afterAll(async () => {
    if (originalPartnerKey === undefined) {
      delete process.env.OPENAI_CHATGPT_API_KEY;
    } else {
      process.env.OPENAI_CHATGPT_API_KEY = originalPartnerKey;
    }
    await db
      .delete(openai_chatgpt_connections)
      .where(inArray(openai_chatgpt_connections.organization_id, [orgA.id, orgB.id]));
    await db
      .delete(openai_chatgpt_connections)
      .where(
        and(
          inArray(openai_chatgpt_connections.kilo_user_id, [user.id, otherUser.id]),
          isNull(openai_chatgpt_connections.organization_id)
        )
      );
    await db.delete(organizations).where(inArray(organizations.id, [orgA.id, orgB.id]));
  });

  it('stores one connection per account with the member as the owner', async () => {
    const [personalRow] = await db
      .select()
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.kilo_user_id, user.id),
          isNull(openai_chatgpt_connections.organization_id)
        )
      );
    const [orgRow] = await db
      .select()
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.kilo_user_id, user.id),
          eq(openai_chatgpt_connections.organization_id, orgA.id)
        )
      );

    expect(personalRow?.organization_id).toBeNull();
    // The connection is personal, so the member owns the organization row too.
    expect(orgRow?.kilo_user_id).toBe(user.id);
    expect(orgRow?.created_by).toBe(user.id);
  });

  it('reads each account its own connection', async () => {
    await expect(
      getOpenAiChatGptStoredConnection({ kiloUserId: user.id, organizationId: null })
    ).resolves.toMatchObject({ connection: { email: personalEmail } });

    const orgAStored = await getOpenAiChatGptStoredConnection({
      kiloUserId: user.id,
      organizationId: orgA.id,
    });
    expect(orgAStored?.connection.email).toContain('org-a-');
    expect(orgAStored?.connection.email).not.toBe(personalEmail);
  });

  it('reads no connection for an account without one, never another account connection', async () => {
    await expect(
      getOpenAiChatGptStoredConnection({ kiloUserId: user.id, organizationId: orgB.id })
    ).resolves.toBeNull();
  });

  it('routes an organization request to the member connection for that organization', async () => {
    await expect(
      isOpenAiChatGptEligible({
        request: responsesRequest(),
        requestedModel: REQUESTED_MODEL,
        userId: user.id,
        organizationId: orgA.id,
      })
    ).resolves.toBe(true);
  });

  it('keeps two members of the same organization on their own connections', async () => {
    const first = await getOpenAiChatGptStoredConnection({
      kiloUserId: user.id,
      organizationId: orgA.id,
    });
    const second = await getOpenAiChatGptStoredConnection({
      kiloUserId: otherUser.id,
      organizationId: orgA.id,
    });

    expect(first?.connection.email).toContain('org-a-');
    expect(first?.connection.email).not.toContain('other');
    expect(second?.connection.email).toContain('org-a-other-');
    expect(second?.connection.email).not.toBe(first?.connection.email);
  });

  it('does not route an account without a connection, even when another account has one', async () => {
    await expect(
      isOpenAiChatGptEligible({
        request: responsesRequest(),
        requestedModel: REQUESTED_MODEL,
        userId: user.id,
        organizationId: orgB.id,
      })
    ).resolves.toBe(false);

    await expect(
      getOpenAiChatGptByokModelIds({ kiloUserId: user.id, organizationId: orgB.id }, [
        REQUESTED_MODEL,
      ])
    ).resolves.toBeNull();
    // The personal account and the connected organization still get the set:
    // the empty organization is the only one excluded.
    await expect(
      getOpenAiChatGptByokModelIds({ kiloUserId: user.id, organizationId: orgA.id }, [
        REQUESTED_MODEL,
      ])
    ).resolves.toEqual(new Set([REQUESTED_MODEL]));
    await expect(
      getOpenAiChatGptByokModelIds({ kiloUserId: user.id, organizationId: null }, [REQUESTED_MODEL])
    ).resolves.toEqual(new Set([REQUESTED_MODEL]));
  });
});
