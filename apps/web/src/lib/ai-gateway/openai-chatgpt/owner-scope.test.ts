jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { byok_api_keys, organizations } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { OPENAI_CHATGPT_PROVIDER_ID } from './provider-id';
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
  let personalEmail: string;
  let orgA: { id: string };
  let orgB: { id: string };

  beforeAll(async () => {
    process.env.OPENAI_CHATGPT_API_KEY = 'partner-project-key';
    user = await insertTestUser({
      google_user_email: `chatgpt-owner-${randomUUID()}@example.com`,
    });
    orgA = await createTestOrganization(`ChatGPT Org A ${randomUUID()}`, user.id, 0);
    orgB = await createTestOrganization(`ChatGPT Org B ${randomUUID()}`, user.id, 0);

    personalEmail = `personal-${randomUUID()}@example.com`;
    await saveOpenAiChatGptConnection(
      { type: 'user', id: user.id },
      connection(personalEmail),
      user.id
    );
    await saveOpenAiChatGptConnection(
      { type: 'org', id: orgA.id },
      connection(`org-a-${randomUUID()}@example.com`),
      user.id
    );
  });

  afterAll(async () => {
    if (originalPartnerKey === undefined) {
      delete process.env.OPENAI_CHATGPT_API_KEY;
    } else {
      process.env.OPENAI_CHATGPT_API_KEY = originalPartnerKey;
    }
    await db
      .delete(byok_api_keys)
      .where(
        and(
          eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID),
          inArray(byok_api_keys.organization_id, [orgA.id, orgB.id])
        )
      );
    await db
      .delete(byok_api_keys)
      .where(
        and(
          eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID),
          eq(byok_api_keys.kilo_user_id, user.id)
        )
      );
    await db.delete(organizations).where(inArray(organizations.id, [orgA.id, orgB.id]));
  });

  it('stores one connection per account with the owner column set', async () => {
    const [personalRow] = await db
      .select()
      .from(byok_api_keys)
      .where(
        and(
          eq(byok_api_keys.kilo_user_id, user.id),
          eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)
        )
      );
    const [orgRow] = await db
      .select()
      .from(byok_api_keys)
      .where(
        and(
          eq(byok_api_keys.organization_id, orgA.id),
          eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)
        )
      );

    expect(personalRow?.organization_id).toBeNull();
    expect(orgRow?.kilo_user_id).toBeNull();
    expect(orgRow?.created_by).toBe(user.id);
  });

  it('reads each account its own connection', async () => {
    await expect(
      getOpenAiChatGptStoredConnection({ type: 'user', id: user.id })
    ).resolves.toMatchObject({ connection: { email: personalEmail } });

    const orgAStored = await getOpenAiChatGptStoredConnection({ type: 'org', id: orgA.id });
    expect(orgAStored?.connection.email).toContain('org-a-');
    expect(orgAStored?.connection.email).not.toBe(personalEmail);
  });

  it('reads no connection for an organization without one, never the personal connection', async () => {
    await expect(
      getOpenAiChatGptStoredConnection({ type: 'org', id: orgB.id })
    ).resolves.toBeNull();
  });

  it('routes an organization request to the organization connection', async () => {
    await expect(
      isOpenAiChatGptEligible({
        request: responsesRequest(),
        requestedModel: REQUESTED_MODEL,
        userId: user.id,
        organizationId: orgA.id,
      })
    ).resolves.toBe(true);
  });

  it('does not route an organization without a connection, even when the caller has a personal one', async () => {
    await expect(
      isOpenAiChatGptEligible({
        request: responsesRequest(),
        requestedModel: REQUESTED_MODEL,
        userId: user.id,
        organizationId: orgB.id,
      })
    ).resolves.toBe(false);

    await expect(
      getOpenAiChatGptByokModelIds({ type: 'org', id: orgB.id }, [REQUESTED_MODEL])
    ).resolves.toBeNull();
    // The same caller on a personal request, or for the connected organization,
    // still gets the BYOK set: the empty organization is the only one excluded.
    await expect(
      getOpenAiChatGptByokModelIds({ type: 'org', id: orgA.id }, [REQUESTED_MODEL])
    ).resolves.toEqual(new Set([REQUESTED_MODEL]));
    await expect(
      getOpenAiChatGptByokModelIds({ type: 'user', id: user.id }, [REQUESTED_MODEL])
    ).resolves.toEqual(new Set([REQUESTED_MODEL]));
  });
});
