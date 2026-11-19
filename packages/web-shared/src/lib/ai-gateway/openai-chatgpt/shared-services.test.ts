jest.mock('./served-models', () => ({
  isOpenAiModelServed: jest.fn(async () => true),
}));

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { kilocode_users, openai_chatgpt_connections, type User } from '@kilocode/db/schema';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { openAiChatGptConnectorGone } from './connector';
import {
  clearOpenAiChatGptConnection,
  clearOpenAiChatGptUsageLimit,
  getOpenAiChatGptStoredConnection,
  openAiChatGptSharedServicesOwner,
  readOpenAiChatGptUsageLimit,
  recordOpenAiChatGptUsageLimit,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from './store';
import type { OpenAiChatGptConnection } from './types';
import { CHATGPT_BUSINESS_USAGE_LIMIT_CODE } from './usage-limit';

const originalPartnerKey = process.env.OPENAI_CHATGPT_API_KEY;

const ACCESS_TOKEN = 'access-token';

/** The credential a reconnect writes in place of `ACCESS_TOKEN`. */
const REPLACEMENT_ACCESS_TOKEN = 'replacement-access-token';

function connection(email: string): OpenAiChatGptConnection {
  return {
    access_token: ACCESS_TOKEN,
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

/**
 * Removes an account the way erasure does: the person's own connection rows go
 * first, the way `softDeleteUser` deletes them (it clears the shared row's
 * connector reference itself, and that path has its own coverage in
 * `lib/user/index.test.ts`). The account row then goes, so the foreign key must
 * clear the connector reference on the shared row instead of removing the
 * organization's connection along with it.
 */
async function deleteAccount(userId: string): Promise<void> {
  await db
    .delete(openai_chatgpt_connections)
    .where(
      and(
        eq(openai_chatgpt_connections.kilo_user_id, userId),
        eq(openai_chatgpt_connections.is_shared_services, false)
      )
    );
  await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
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

  it('keeps the organization shared row when the connector account is deleted, and requires a reconnect', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    const connector = await insertTestUser({
      google_user_email: `shared-services-connector-${randomUUID()}@example.com`,
    });
    await saveOpenAiChatGptConnection(shared, connection('kept@example.com'), connector.id);

    await deleteAccount(connector.id);

    // The row is the organization's connection, so it survives its connector
    // and keeps the credential that connector connected.
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

    const stored = await getOpenAiChatGptStoredConnection(shared);
    if (!stored) throw new Error('the shared row went missing with its connector');
    expect(stored).toMatchObject({
      connection: { email: 'kept@example.com' },
      createdBy: connector.id,
    });

    // The credential is the deleted person's account, and nobody is left who
    // can refresh it: the row reads as gone so routing skips it and the status
    // card asks an organization owner or admin to reconnect.
    await expect(openAiChatGptConnectorGone(stored)).resolves.toBe(true);
  });

  it('records a plan limit on the shared row only', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    const memberOwner = { kiloUserId: owner.id, organizationId: organization.id };

    await recordOpenAiChatGptUsageLimit(shared, ACCESS_TOKEN, {
      code: null,
      resetsAt: Date.now() + 60 * 60 * 1000,
    });

    await expect(readOpenAiChatGptUsageLimit(shared)).resolves.toMatchObject({
      resetsAt: expect.any(String),
      code: null,
    });
    await expect(readOpenAiChatGptUsageLimit(memberOwner)).resolves.toBeNull();
  });

  it('replaces workspace guidance when a consumer limit follows', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    await recordOpenAiChatGptUsageLimit(shared, ACCESS_TOKEN, {
      code: CHATGPT_BUSINESS_USAGE_LIMIT_CODE,
      resetsAt: null,
    });
    await expect(readOpenAiChatGptUsageLimit(shared)).resolves.toMatchObject({
      code: CHATGPT_BUSINESS_USAGE_LIMIT_CODE,
      resetsAt: null,
    });

    await recordOpenAiChatGptUsageLimit(shared, ACCESS_TOKEN, { code: null, resetsAt: null });
    await expect(readOpenAiChatGptUsageLimit(shared)).resolves.toMatchObject({ code: null });
  });

  it('clears a recorded limit once a request through that row succeeded', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);

    await recordOpenAiChatGptUsageLimit(shared, ACCESS_TOKEN, {
      code: CHATGPT_BUSINESS_USAGE_LIMIT_CODE,
      resetsAt: Date.now() + 60 * 60 * 1000,
    });
    await clearOpenAiChatGptUsageLimit(shared, ACCESS_TOKEN);
    await expect(readOpenAiChatGptUsageLimit(shared)).resolves.toBeNull();
    const [row] = await db
      .select({ code: openai_chatgpt_connections.usage_limit_error_code })
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.organization_id, organization.id),
          eq(openai_chatgpt_connections.is_shared_services, true)
        )
      );
    expect(row.code).toBeNull();

    // A success on a row that never hit a limit writes nothing and must not throw.
    await expect(clearOpenAiChatGptUsageLimit(shared, ACCESS_TOKEN)).resolves.toBeUndefined();
  });

  it('restores the shared row when a live owner reconnects after its connector is gone', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    const connector = await insertTestUser({
      google_user_email: `shared-services-reconnect-${randomUUID()}@example.com`,
    });
    await saveOpenAiChatGptConnection(
      shared,
      connection('before-reconnect@example.com'),
      connector.id
    );
    await deleteAccount(connector.id);

    const abandoned = await getOpenAiChatGptStoredConnection(shared);
    if (!abandoned) throw new Error('the shared row went missing with its connector');
    await expect(openAiChatGptConnectorGone(abandoned)).resolves.toBe(true);

    // A live person claims the organization's row: the reconnect replaces the
    // connector and the credential together, and the row serves again.
    await saveOpenAiChatGptConnection(
      shared,
      { ...connection('after-reconnect@example.com'), access_token: REPLACEMENT_ACCESS_TOKEN },
      owner.id
    );

    const restored = await getOpenAiChatGptStoredConnection(shared);
    if (!restored) throw new Error('the reconnect did not leave a stored connection');
    expect(restored.createdBy).toBe(owner.id);
    expect(restored.connection).toMatchObject({
      email: 'after-reconnect@example.com',
      access_token: REPLACEMENT_ACCESS_TOKEN,
    });
    await expect(openAiChatGptConnectorGone(restored)).resolves.toBe(false);
  });

  it('treats a shared row whose connector is soft-deleted as needing a reconnect', async () => {
    const shared = openAiChatGptSharedServicesOwner(organization.id);
    const erased = await insertTestUser({
      google_user_email: `shared-services-soft-deleted-${randomUUID()}@example.com`,
    });
    await saveOpenAiChatGptConnection(shared, connection('soft-deleted@example.com'), erased.id);

    // Erasure keeps the account row and its address, so only the blocked
    // reason says the person is gone.
    await db
      .update(kilocode_users)
      .set({ blocked_reason: createSoftDeletedBlockedReason() })
      .where(eq(kilocode_users.id, erased.id));

    const blocked = await getOpenAiChatGptStoredConnection(shared);
    if (!blocked) throw new Error('the shared row went missing with its connector');
    expect(blocked.createdBy).toBe(erased.id);
    await expect(openAiChatGptConnectorGone(blocked)).resolves.toBe(true);

    // The same row with a live connector keeps serving.
    const live = await insertTestUser({
      google_user_email: `shared-services-live-connector-${randomUUID()}@example.com`,
    });
    await saveOpenAiChatGptConnection(shared, connection('live@example.com'), live.id);

    const served = await getOpenAiChatGptStoredConnection(shared);
    if (!served) throw new Error('the live connector did not leave a stored connection');
    await expect(openAiChatGptConnectorGone(served)).resolves.toBe(false);
  });

  it('keeps a late report from a replaced credential off the reconnected row', async () => {
    const person = await insertTestUser({
      google_user_email: `usage-limit-reconnect-${randomUUID()}@example.com`,
    });
    const personalOwner: OpenAiChatGptOwner = {
      kiloUserId: person.id,
      organizationId: null,
    };

    await saveOpenAiChatGptConnection(personalOwner, connection('first@example.com'), person.id);
    await saveOpenAiChatGptConnection(
      personalOwner,
      { ...connection('second@example.com'), access_token: REPLACEMENT_ACCESS_TOKEN },
      person.id
    );

    // The response for the request that carried the replaced credential arrives
    // after the reconnect.
    await recordOpenAiChatGptUsageLimit(personalOwner, ACCESS_TOKEN, {
      code: null,
      resetsAt: Date.now() + 60 * 60 * 1000,
    });

    await expect(readOpenAiChatGptUsageLimit(personalOwner)).resolves.toBeNull();
    const [row] = await db
      .select({
        reachedAt: openai_chatgpt_connections.usage_limit_reached_at,
        resetsAt: openai_chatgpt_connections.usage_limit_resets_at,
        code: openai_chatgpt_connections.usage_limit_error_code,
      })
      .from(openai_chatgpt_connections)
      .where(eq(openai_chatgpt_connections.kilo_user_id, person.id));
    expect(row).toEqual({ reachedAt: null, resetsAt: null, code: null });

    // The credential the row holds now still records its own limit.
    await recordOpenAiChatGptUsageLimit(personalOwner, REPLACEMENT_ACCESS_TOKEN, {
      code: null,
      resetsAt: Date.now() + 60 * 60 * 1000,
    });
    await expect(readOpenAiChatGptUsageLimit(personalOwner)).resolves.toMatchObject({
      code: null,
      resetsAt: expect.any(String),
    });
  });

  it('keeps a late success from a replaced credential from clearing the reconnected limit', async () => {
    const person = await insertTestUser({
      google_user_email: `usage-limit-clear-${randomUUID()}@example.com`,
    });
    const personalOwner: OpenAiChatGptOwner = {
      kiloUserId: person.id,
      organizationId: null,
    };

    await saveOpenAiChatGptConnection(personalOwner, connection('first@example.com'), person.id);
    await saveOpenAiChatGptConnection(
      personalOwner,
      { ...connection('second@example.com'), access_token: REPLACEMENT_ACCESS_TOKEN },
      person.id
    );
    await recordOpenAiChatGptUsageLimit(personalOwner, REPLACEMENT_ACCESS_TOKEN, {
      code: null,
      resetsAt: Date.now() + 60 * 60 * 1000,
    });

    // A success from the replaced credential says nothing about the row's limit.
    await clearOpenAiChatGptUsageLimit(personalOwner, ACCESS_TOKEN);
    await expect(readOpenAiChatGptUsageLimit(personalOwner)).resolves.toMatchObject({
      code: null,
      resetsAt: expect.any(String),
    });

    await clearOpenAiChatGptUsageLimit(personalOwner, REPLACEMENT_ACCESS_TOKEN);
    await expect(readOpenAiChatGptUsageLimit(personalOwner)).resolves.toBeNull();
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
