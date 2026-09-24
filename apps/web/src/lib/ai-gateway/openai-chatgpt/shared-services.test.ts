jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { kilocode_users, openai_chatgpt_connections, type User } from '@kilocode/db/schema';
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
      .select({
        kilo_user_id: openai_chatgpt_connections.kilo_user_id,
        created_by: openai_chatgpt_connections.created_by,
      })
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.organization_id, organization.id),
          eq(openai_chatgpt_connections.is_shared_services, true)
        )
      );
    expect(sharedRows).toHaveLength(1);
    // The row names the person who connected the credential it now holds: a
    // reconnect replaces the previous connector along with the credential.
    expect(sharedRows[0].kilo_user_id).toBe(member.id);
    expect(sharedRows[0].created_by).toBe(member.id);

    expect((await getOpenAiChatGptStoredConnection(shared))?.connection.email).toBe(
      'shared-again@example.com'
    );
    expect((await getOpenAiChatGptStoredConnection(memberOwner))?.connection.email).toBe(
      'member@example.com'
    );
  });

  it('keeps the organization shared row when the connector account row is deleted', async () => {
    const connector = await insertTestUser({
      google_user_email: `shared-services-connector-${randomUUID()}@example.com`,
    });
    await saveOpenAiChatGptConnection(
      openAiChatGptSharedServicesOwner(organization.id),
      connection('kept@example.com'),
      connector.id
    );

    // A person's own rows go first, the way `softDeleteUser` deletes them (it
    // clears the shared row's connector reference itself, and that path has its
    // own coverage in `lib/user/index.test.ts`). The account row then goes, so
    // the foreign key must clear the connector reference instead of removing the
    // organization's connection along with it.
    await db
      .delete(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.kilo_user_id, connector.id),
          eq(openai_chatgpt_connections.is_shared_services, false)
        )
      );
    await db.delete(kilocode_users).where(eq(kilocode_users.id, connector.id));

    const rows = await db
      .select()
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.organization_id, organization.id),
          eq(openai_chatgpt_connections.is_shared_services, true)
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_shared_services).toBe(true);
    expect(rows[0].kilo_user_id).toBeNull();
    expect(rows[0].created_by).toBe(connector.id);
    await expect(
      getOpenAiChatGptStoredConnection(openAiChatGptSharedServicesOwner(organization.id))
    ).resolves.toMatchObject({ connection: { email: 'kept@example.com' } });
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
