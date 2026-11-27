import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { useFakeByokKmsForSuite } from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  getOpenAiChatGptStoredConnectionFromPrimary,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from './store';
import type { OpenAiChatGptConnection } from './types';

function connection(accessToken: string): OpenAiChatGptConnection {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    scope: 'openid profile email offline_access',
    token_type: 'Bearer',
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: 'subject',
    email: 'chatgpt@example.com',
    connected_at: '2026-09-16T00:00:00.000Z',
    status: 'connected',
  };
}

// Remove with the migration that drops the obsolete column.
describe('saveOpenAiChatGptConnection once encrypted_connection is dropped (real database)', () => {
  let connector: User;
  let reconnector: User;
  let organizationId: string;

  useFakeByokKmsForSuite();

  beforeAll(async () => {
    connector = await insertTestUser({ google_user_email: `chatgpt-${randomUUID()}@example.com` });
    reconnector = await insertTestUser({
      google_user_email: `chatgpt-${randomUUID()}@example.com`,
    });
    organizationId = (await createTestOrganization(`ChatGPT ${randomUUID()}`, connector.id, 0)).id;
    await db.execute(
      sql`ALTER TABLE openai_chatgpt_connections RENAME COLUMN encrypted_connection TO encrypted_connection_dropped`
    );
  });

  afterAll(async () => {
    await db.execute(
      sql`ALTER TABLE openai_chatgpt_connections RENAME COLUMN encrypted_connection_dropped TO encrypted_connection`
    );
  });

  it.each([
    ['a personal connection', () => ({ kiloUserId: connector.id, organizationId: null })],
    ['an organization member connection', () => ({ kiloUserId: connector.id, organizationId })],
    [
      'the organization shared-services connection',
      () => ({ scope: 'shared_services' as const, organizationId }),
    ],
  ])('inserts and then replaces %s', async (_label, ownerFor: () => OpenAiChatGptOwner) => {
    const owner = ownerFor();
    await saveOpenAiChatGptConnection(owner, connection('first'), connector.id);
    await saveOpenAiChatGptConnection(owner, connection('second'), reconnector.id);

    const stored = await getOpenAiChatGptStoredConnectionFromPrimary(owner);
    expect(stored?.connection.access_token).toBe('second');
    expect(stored?.createdBy).toBe(reconnector.id);
  });
});
