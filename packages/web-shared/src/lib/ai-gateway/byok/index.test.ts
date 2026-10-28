import { afterEach, describe, expect, test } from '@jest/globals';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  byokOwner,
  getBYOKforOrganization,
  getBYOKforUser,
  getByokCredentials,
  getEnabledByokProviders,
  getOrganizationByokProviderIds,
  getUserByokProviderIds,
  servesCatalogModels,
  type ByokOwner,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { byok_api_keys, kilocode_users, organizations } from '@kilocode/db/schema';
import type { ByokApiKeySettings } from '@kilocode/db/schema-types';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { inArray } from 'drizzle-orm';

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
  owner: ByokOwner,
  createdBy: string,
  providerId: UserByokProviderId,
  createdAt: string,
  { isEnabled = true, settings = {} }: { isEnabled?: boolean; settings?: ByokApiKeySettings } = {}
) {
  const secret = `${providerId}-${crypto.randomUUID()}`;
  await db.insert(byok_api_keys).values({
    ...(owner.type === 'user' ? { kilo_user_id: owner.id } : { organization_id: owner.id }),
    provider_id: providerId,
    encrypted_api_key: encryptApiKey(secret, BYOK_ENCRYPTION_KEY),
    created_by: createdBy,
    created_at: createdAt,
    is_enabled: isEnabled,
    settings,
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
      { isEnabled: false }
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
      { isEnabled: false }
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

describe('byokOwner', () => {
  test('prefers the organization over the user', () => {
    expect(byokOwner('user-id', 'organization-id')).toEqual({
      type: 'organization',
      id: 'organization-id',
    });
    expect(byokOwner('user-id', undefined)).toEqual({ type: 'user', id: 'user-id' });
    expect(byokOwner('user-id', null)).toEqual({ type: 'user', id: 'user-id' });
  });
});

describe('servesCatalogModels', () => {
  test('is true only for stored settings that enable catalog mode', () => {
    expect(servesCatalogModels({ serve_catalog_models: true })).toBe(true);
    expect(servesCatalogModels({ serve_catalog_models: false })).toBe(false);
    expect(servesCatalogModels({})).toBe(false);
    expect(servesCatalogModels(null)).toBe(false);
    expect(servesCatalogModels({ serve_catalog_models: 'true' })).toBe(false);
  });
});

describe('getEnabledByokProviders', () => {
  test('returns only the owner enabled keys with their catalog mode', async () => {
    const user = await createUser();
    const organization = await createOrganization(user.id);
    const userOwner = byokOwner(user.id, null);
    const organizationOwner = byokOwner(user.id, organization.id);
    await insertByokKey(userOwner, user.id, 'anthropic', '2026-01-01T00:00:00.000Z', {
      settings: { serve_catalog_models: true },
    });
    await insertByokKey(userOwner, user.id, 'minimax', '2026-01-02T00:00:00.000Z');
    await insertByokKey(userOwner, user.id, 'openai', '2026-01-03T00:00:00.000Z', {
      isEnabled: false,
      settings: { serve_catalog_models: true },
    });
    await insertByokKey(organizationOwner, user.id, 'zai', '2026-01-04T00:00:00.000Z', {
      settings: { serve_catalog_models: false },
    });

    const userProviders = await getEnabledByokProviders(db, userOwner);

    expect(userProviders.sort((a, b) => a.providerId.localeCompare(b.providerId))).toEqual([
      { providerId: 'anthropic', serveCatalogModels: true },
      { providerId: 'minimax', serveCatalogModels: false },
    ]);
    await expect(getEnabledByokProviders(db, organizationOwner)).resolves.toEqual([
      { providerId: 'zai', serveCatalogModels: false },
    ]);
  });
});

describe('getByokCredentials', () => {
  test('returns the owner enabled keys for the providers in creation order', async () => {
    const user = await createUser();
    const organization = await createOrganization(user.id);
    const userOwner = byokOwner(user.id, null);
    const organizationOwner = byokOwner(user.id, organization.id);
    const anthropicSecret = await insertByokKey(
      userOwner,
      user.id,
      'anthropic',
      '2026-01-02T00:00:00.000Z',
      { settings: { serve_catalog_models: true } }
    );
    const minimaxSecret = await insertByokKey(
      userOwner,
      user.id,
      'minimax',
      '2026-01-01T00:00:00.000Z'
    );
    await insertByokKey(userOwner, user.id, 'openai', '2026-01-03T00:00:00.000Z', {
      isEnabled: false,
    });
    const organizationSecret = await insertByokKey(
      organizationOwner,
      user.id,
      'anthropic',
      '2026-01-04T00:00:00.000Z'
    );

    await expect(
      getByokCredentials(db, userOwner, ['openai', 'minimax', 'anthropic', 'zai'])
    ).resolves.toEqual([
      { decryptedAPIKey: minimaxSecret, providerId: 'minimax', serveCatalogModels: false },
      { decryptedAPIKey: anthropicSecret, providerId: 'anthropic', serveCatalogModels: true },
    ]);
    await expect(
      db.transaction(tx => getByokCredentials(tx, organizationOwner, ['anthropic', 'minimax']))
    ).resolves.toEqual([
      { decryptedAPIKey: organizationSecret, providerId: 'anthropic', serveCatalogModels: false },
    ]);
    await expect(getByokCredentials(db, userOwner, [])).resolves.toEqual([]);
    await expect(getByokCredentials(db, organizationOwner, ['openai'])).resolves.toEqual([]);
  });

  test('backs getBYOKforUser without exposing catalog mode', async () => {
    const user = await createUser();
    await insertByokKey(
      byokOwner(user.id, null),
      user.id,
      'anthropic',
      '2026-01-01T00:00:00.000Z',
      {
        settings: { serve_catalog_models: true },
      }
    );

    await expect(getBYOKforUser(db, user.id, ['anthropic'])).resolves.toEqual([
      { decryptedAPIKey: expect.any(String), providerId: 'anthropic' },
    ]);
  });
});
