import { custom_llm2 } from '@kilocode/db/schema';
import type { CustomLlmDefinition, EncryptedData } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { invalidateCustomLlmCache } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { eq } from 'drizzle-orm';

const baseDefinition = {
  internal_id: 'upstream-model',
  context_length: 128_000,
  max_completion_tokens: 4096,
  base_url: 'https://upstream.example.com/v1',
};

export function privateCustomLlmDefinition(
  overrides: Partial<CustomLlmDefinition> = {}
): CustomLlmDefinition {
  return {
    ...baseDefinition,
    display_name: 'Private custom LLM',
    organization_ids: [],
    ...overrides,
  };
}

export function publicCustomLlmDefinition(
  inferenceProviders: string[],
  overrides: Partial<CustomLlmDefinition> = {}
): CustomLlmDefinition {
  return {
    ...baseDefinition,
    display_name: 'Public custom LLM',
    description: 'A public custom LLM',
    public: { inference_providers: inferenceProviders },
    ...overrides,
  };
}

export async function insertCustomLlmForTest(
  publicId: string,
  definition: CustomLlmDefinition,
  encryptedApiKey: EncryptedData | null = null
) {
  await db
    .insert(custom_llm2)
    .values({ public_id: publicId, definition, encrypted_api_key: encryptedApiKey });
  invalidateCustomLlmCache();
}

export async function deleteCustomLlmForTest(publicId: string) {
  await db.delete(custom_llm2).where(eq(custom_llm2.public_id, publicId));
  invalidateCustomLlmCache();
}
