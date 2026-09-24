jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { openai_chatgpt_connections, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import {
  clearOpenAiChatGptConnection,
  getOpenAiChatGptStoredConnection,
  openAiChatGptSharedServicesOwner,
  readOpenAiChatGptUsageLimit,
  recordOpenAiChatGptUsageLimit,
  saveOpenAiChatGptConnection,
} from './store';
import type { OpenAiChatGptConnection } from './types';

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

describe('openai-chatgpt shared-services connection (real database)', () => {
  let owner: User;
  let member: User;
  let organization: { id: string };

  beforeAll(async () => {
    process.env.OPENAI_CHATGPT_API_KEY = 'partner-project-key';
    owner = await insertTestUser({
      google_user_email: `shared-services-owner-${randomUUID()}@example.com`,
    });
    member = await insertTestUser({
      google_user_email: `shared-services-member-${randomUUID()}@example.com`,
    });
    organization = await createTestOrganization(`Shared services ${randomUUID()}`, owner.id, 0);
  });

  afterAll(async () => {
    if (originalPartnerKey === undefined) {
      delete process.env.OPENAI_CHATGPT_API_KEY;
    } else {
      process.env.OPENAI_CHATGPT_API_KEY = originalPartnerKey;
    }
  });

  it('keeps one shared row per organization, apart from a member row', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    const memberOwner = { kiloUserId: owner.id, organizationId: organization.id };

    await saveOpenAiChatGptConnection(shared, connection('shared@example.com'), owner.id);
    // A second connect replaces the same single row, whoever connects it.
    await saveOpenAiChatGptConnection(shared, connection('shared-again@example.com'), member.id);
    await saveOpenAiChatGptConnection(memberOwner, connection('member@example.com'), owner.id);

    const sharedRows = await db
      .select({ kilo_user_id: openai_chatgpt_connections.kilo_user_id })
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.organization_id, organization.id),
          eq(openai_chatgpt_connections.is_shared_services, true)
        )
      );
    expect(sharedRows).toHaveLength(1);
    // Reconnecting replaces the credential, not the connector of record.
    expect(sharedRows[0].kilo_user_id).toBe(owner.id);

    expect((await getOpenAiChatGptStoredConnection(shared))?.connection.email).toBe(
      'shared-again@example.com'
    );
    expect((await getOpenAiChatGptStoredConnection(memberOwner))?.connection.email).toBe(
      'member@example.com'
    );
  });

  it('records a plan limit on the shared row only', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    const memberOwner = { kiloUserId: owner.id, organizationId: organization.id };

    await recordOpenAiChatGptUsageLimit(shared, { resetsAt: Date.now() + 60 * 60 * 1000 });

    await expect(readOpenAiChatGptUsageLimit(shared)).resolves.toMatchObject({
      resetsAt: expect.any(String),
    });
    await expect(readOpenAiChatGptUsageLimit(memberOwner)).resolves.toBeNull();
  });

  it('deletes the shared row and leaves the member row in place', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    const memberOwner = { kiloUserId: owner.id, organizationId: organization.id };

    await clearOpenAiChatGptConnection(shared);

    await expect(getOpenAiChatGptStoredConnection(shared)).resolves.toBeNull();
    expect((await getOpenAiChatGptStoredConnection(memberOwner))?.connection.email).toBe(
      'member@example.com'
    );
  });
});
