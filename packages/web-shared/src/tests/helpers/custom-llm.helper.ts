import { custom_llm2 } from '@kilocode/db/schema';
import type { CustomLlmDefinition, EncryptedData } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { resetCustomLlmCacheForTest } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { eq } from 'drizzle-orm';

export function customLlmDefinition(
  overrides: Partial<CustomLlmDefinition> = {}
): CustomLlmDefinition {
  return {
    internal_id: 'upstream-model',
    display_name: 'Custom LLM',
    context_length: 128_000,
    max_completion_tokens: 4096,
    base_url: 'https://upstream.example.com/v1',
    organization_ids: [],
    ...overrides,
  };
}

export async function insertCustomLlmForTest(
  publicId: string,
  definition: CustomLlmDefinition = customLlmDefinition(),
  encryptedApiKey: EncryptedData | null = null
) {
  await db
    .insert(custom_llm2)
    .values({ public_id: publicId, definition, encrypted_api_key: encryptedApiKey });
  resetCustomLlmCacheForTest();
}

export async function deleteCustomLlmForTest(publicId: string) {
  await db.delete(custom_llm2).where(eq(custom_llm2.public_id, publicId));
  resetCustomLlmCacheForTest();
}
