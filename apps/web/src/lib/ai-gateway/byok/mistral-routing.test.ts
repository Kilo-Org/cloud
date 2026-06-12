/* eslint-disable drizzle/enforce-delete-with-where */
import { getBYOKforUser, getModelUserByokProviders } from '@/lib/ai-gateway/byok';
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { applyVercelSettings } from '@/lib/ai-gateway/providers/vercel';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { byok_api_keys, kilocode_users } from '@kilocode/db/schema';

afterEach(async () => {
  await db.delete(byok_api_keys);
  await db.delete(kilocode_users);
});

describe('Mistral BYOK routing', () => {
  it.each(['mistralai/mistral-small', 'mistralai/codestral-2508'])(
    'uses both Mistral key types for %s',
    async modelId => {
      await expect(getModelUserByokProviders(modelId)).resolves.toEqual(['mistral', 'codestral']);
    }
  );

  it('returns the Mistral key before the legacy Codestral key', async () => {
    const user = await insertTestUser();
    await db.insert(byok_api_keys).values([
      {
        kilo_user_id: user.id,
        provider_id: 'codestral',
        encrypted_api_key: encryptApiKey('codestral-key', BYOK_ENCRYPTION_KEY),
        created_at: '2026-01-01T00:00:00.000Z',
        created_by: user.id,
      },
      {
        kilo_user_id: user.id,
        provider_id: 'mistral',
        encrypted_api_key: encryptApiKey('mistral-key', BYOK_ENCRYPTION_KEY),
        created_at: '2026-02-01T00:00:00.000Z',
        created_by: user.id,
      },
    ]);

    const byok = await getBYOKforUser(db, user.id, ['mistral', 'codestral']);

    expect(byok?.map(key => key.providerId)).toEqual(['mistral', 'codestral']);
    expect(byok?.map(key => key.decryptedAPIKey)).toEqual(['mistral-key', 'codestral-key']);

    const request = {
      kind: 'chat_completions',
      body: { model: 'mistralai/mistral-small', messages: [] },
    } as GatewayRequest;
    applyVercelSettings('mistralai/mistral-small', request, byok);

    expect(request.body.providerOptions?.gateway?.byok?.mistral).toEqual([
      { apiKey: 'mistral-key' },
      { apiKey: 'codestral-key' },
    ]);
  });
});
