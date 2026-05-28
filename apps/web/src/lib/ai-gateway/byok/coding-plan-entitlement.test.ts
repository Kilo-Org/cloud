/* eslint-disable drizzle/enforce-delete-with-where */
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { getBYOKforUser } from '@/lib/ai-gateway/byok';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { byok_api_keys, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

async function seedMiniMaxKey(managementSource: 'user' | 'coding_plan', isEnabled = true) {
  const user = await insertTestUser();
  await db.insert(byok_api_keys).values({
    kilo_user_id: user.id,
    provider_id: 'minimax',
    encrypted_api_key: encryptApiKey(`minimax-${crypto.randomUUID()}`, BYOK_ENCRYPTION_KEY),
    management_source: managementSource,
    is_enabled: isEnabled,
    created_by: user.id,
  });
  return user;
}

afterEach(async () => {
  await db.delete(byok_api_keys);
  await db.delete(kilocode_users);
});

describe('Coding Plan MiniMax BYOK routing', () => {
  it('loads a Token Plan Plus-installed key through ordinary MiniMax routing', async () => {
    const user = await seedMiniMaxKey('coding_plan');

    const byok = await getBYOKforUser(db, user.id, ['minimax']);

    expect(byok).toHaveLength(1);
    expect(byok?.[0].providerId).toBe('minimax');
  });

  it('uses a subscriber replacement as ordinary MiniMax BYOK', async () => {
    const user = await seedMiniMaxKey('user');

    const byok = await getBYOKforUser(db, user.id, ['minimax']);

    expect(byok).toHaveLength(1);
    expect(byok?.[0].providerId).toBe('minimax');
  });

  it('does not route a disabled MiniMax BYOK key', async () => {
    const user = await seedMiniMaxKey('coding_plan', false);

    expect(await getBYOKforUser(db, user.id, ['minimax'])).toBeNull();
  });

  it('does not route after the configured MiniMax key is deleted', async () => {
    const user = await seedMiniMaxKey('coding_plan');
    await db.delete(byok_api_keys).where(eq(byok_api_keys.kilo_user_id, user.id));

    expect(await getBYOKforUser(db, user.id, ['minimax'])).toBeNull();
  });
});
