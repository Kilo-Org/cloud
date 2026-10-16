import { beforeEach, describe, expect, it } from '@jest/globals';
import { byok_api_keys, type User } from '@kilocode/db/schema';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const MODEL = 'opencode-go/qwen3.7-plus';

function resolveProvider(userId: string, organizationId: string | undefined) {
  return getProvider({
    requestedModel: MODEL,
    request: {
      kind: 'generate_content',
      body: { model: MODEL, stream: false, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    },
    user: { id: userId } as User,
    organizationId,
    taskId: undefined,
  });
}

describe('getProvider OpenCode Go Gemini API', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('serves the Gemini API for a personal key from the Google-compatible endpoint', async () => {
    const user = await insertTestUser();
    await db.insert(byok_api_keys).values({
      kilo_user_id: user.id,
      provider_id: 'opencode-go',
      encrypted_api_key: encryptApiKey('personal-key', BYOK_ENCRYPTION_KEY),
      created_by: user.id,
    });

    const result = await resolveProvider(user.id, undefined);

    expect(result).toMatchObject({
      kind: 'provider',
      provider: {
        id: 'direct-byok',
        apiKey: 'personal-key',
        apiUrlOverrides: { generate_content: 'https://opencode.ai/inference/go/google/v1beta' },
        supportedChatApis: ['chat_completions', 'messages', 'responses', 'generate_content'],
      },
    });
  });

  it('does not serve the Gemini API for an organization key', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Gemini org', user.id, 0);
    await db.insert(byok_api_keys).values({
      organization_id: organization.id,
      provider_id: 'opencode-go',
      encrypted_api_key: encryptApiKey('organization-key', BYOK_ENCRYPTION_KEY),
      created_by: user.id,
    });

    const result = await resolveProvider(user.id, organization.id);

    expect(result).toMatchObject({
      kind: 'provider',
      provider: {
        id: 'direct-byok',
        apiKey: 'organization-key',
        supportedChatApis: ['chat_completions', 'messages', 'responses'],
      },
    });
  });
});
