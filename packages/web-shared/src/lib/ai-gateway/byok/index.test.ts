import { afterEach, describe, expect, test } from '@jest/globals';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  getBYOKforOrganization,
  getBYOKforUser,
  getOrganizationByokProviderIds,
  getUserByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { byok_api_keys, kilocode_users, organizations } from '@kilocode/db/schema';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { inArray } from 'drizzle-orm';

type Owner = { type: 'user'; id: string } | { type: 'organization'; id: string };

const createdUserIds: string[] = [];
const createdOrganizationIds: string[] = [];

async function createUser() {
  const user = await insertTestUser();
  createdUserIds.push(user.id);
  return user;
}

async function createOrganization(ownerId: string) {
  const organization = await createTestOrganization(
    `BYOK owner ${crypto.randomUUID()}`,
    ownerId,
    0
  );
  createdOrganizationIds.push(organization.id);
  return organization;
}

async function insertByokKey(
  owner: Owner,
  createdBy: string,
  providerId: UserByokProviderId,
  createdAt: string,
  isEnabled = true
) {
  const secret = `${providerId}-${crypto.randomUUID()}`;
  await db.insert(byok_api_keys).values({
    ...(owner.type === 'user' ? { kilo_user_id: owner.id } : { organization_id: owner.id }),
    provider_id: providerId,
    encrypted_api_key: encryptApiKey(secret, BYOK_ENCRYPTION_KEY),
    created_by: createdBy,
    created_at: createdAt,
    is_enabled: isEnabled,
  });
  return secret;
}

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    createdUserIds.length = 0;
  }
  if (createdOrganizationIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
    createdOrganizationIds.length = 0;
  }
});

describe('getBYOKforUser', () => {
  test('returns only the user enabled keys in creation order', async () => {
    const user = await createUser();
    const otherUser = await createUser();
    const anthropicSecret = await insertByokKey(
      { type: 'user', id: user.id },
      user.id,
      'anthropic',
      '2026-01-02T00:00:00.000Z'
    );
    const minimaxSecret = await insertByokKey(
      { type: 'user', id: user.id },
      user.id,
      'minimax',
      '2026-01-01T00:00:00.000Z'
    );
    await insertByokKey(
      { type: 'user', id: user.id },
      user.id,
      'openai',
      '2026-01-03T00:00:00.000Z',
      false
    );
    await insertByokKey(
      { type: 'user', id: otherUser.id },
      otherUser.id,
      'zai',
      '2026-01-04T00:00:00.000Z'
    );

    const byok = await getBYOKforUser(db, user.id, ['openai', 'minimax', 'anthropic', 'zai']);

    expect(byok?.map(entry => entry.providerId)).toEqual(['minimax', 'anthropic']);
    expect(byok?.map(entry => entry.decryptedAPIKey)).toEqual([minimaxSecret, anthropicSecret]);
    expect((await getUserByokProviderIds(db, user.id)).sort()).toEqual(['anthropic', 'minimax']);
    expect(await getUserByokProviderIds(db, otherUser.id)).toEqual(['zai']);
  });

  test('returns null for an empty provider list or a user without matching keys', async () => {
    const user = await createUser();
    const userWithoutKeys = await createUser();
    await insertByokKey(
      { type: 'user', id: user.id },
      user.id,
      'anthropic',
      '2026-01-01T00:00:00.000Z'
    );

    await expect(getBYOKforUser(db, user.id, [])).resolves.toBeNull();
    await expect(getBYOKforUser(db, user.id, ['zai'])).resolves.toBeNull();
    await expect(getBYOKforUser(db, userWithoutKeys.id, ['anthropic'])).resolves.toBeNull();
    await expect(getUserByokProviderIds(db, userWithoutKeys.id)).resolves.toEqual([]);
  });
});

describe('getBYOKforOrganization', () => {
  test('returns only the organization enabled keys in creation order', async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const organization = await createOrganization(owner.id);
    const otherOrganization = await createOrganization(otherOwner.id);
    const anthropicSecret = await insertByokKey(
      { type: 'organization', id: organization.id },
      owner.id,
      'anthropic',
      '2026-01-02T00:00:00.000Z'
    );
    const minimaxSecret = await insertByokKey(
      { type: 'organization', id: organization.id },
      owner.id,
      'minimax',
      '2026-01-01T00:00:00.000Z'
    );
    await insertByokKey(
      { type: 'organization', id: organization.id },
      owner.id,
      'openai',
      '2026-01-03T00:00:00.000Z',
      false
    );
    await insertByokKey(
      { type: 'organization', id: otherOrganization.id },
      otherOwner.id,
      'zai',
      '2026-01-04T00:00:00.000Z'
    );

    const byok = await getBYOKforOrganization(db, organization.id, [
      'openai',
      'minimax',
      'anthropic',
      'zai',
    ]);

    expect(byok?.map(entry => entry.providerId)).toEqual(['minimax', 'anthropic']);
    expect(byok?.map(entry => entry.decryptedAPIKey)).toEqual([minimaxSecret, anthropicSecret]);
    expect((await getOrganizationByokProviderIds(db, organization.id)).sort()).toEqual([
      'anthropic',
      'minimax',
    ]);
    expect(await getOrganizationByokProviderIds(db, otherOrganization.id)).toEqual(['zai']);
  });

  test('accepts a transaction and returns null for an empty provider list or no keys', async () => {
    const owner = await createUser();
    const organization = await createOrganization(owner.id);
    const organizationWithoutKeys = await createOrganization(owner.id);
    await insertByokKey(
      { type: 'organization', id: organization.id },
      owner.id,
      'anthropic',
      '2026-01-01T00:00:00.000Z'
    );

    await expect(
      db.transaction(tx => getBYOKforOrganization(tx, organization.id, ['anthropic']))
    ).resolves.toEqual([{ decryptedAPIKey: expect.any(String), providerId: 'anthropic' }]);
    await expect(getBYOKforOrganization(db, organization.id, [])).resolves.toBeNull();
    await expect(
      getBYOKforOrganization(db, organizationWithoutKeys.id, ['anthropic'])
    ).resolves.toBeNull();
    await expect(getOrganizationByokProviderIds(db, organizationWithoutKeys.id)).resolves.toEqual(
      []
    );
  });
});
