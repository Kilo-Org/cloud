import { sealOpenAiChatGptConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/connection-encryption';
import type { OpenAiChatGptConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/types';
import { TEST_BYOK_DATA_KEY } from './byok-kms.helper';

/**
 * The payload columns of a ChatGPT connection row as the writers produce them under
 * `useFakeByokKms`: the envelope's data key is `TEST_BYOK_DATA_KEY`. Each call uses a new
 * random `key_id`.
 */
export function sealedOpenAiChatGptConnectionColumns(connection: OpenAiChatGptConnection) {
  return sealOpenAiChatGptConnection(connection, {
    keyId: crypto.randomUUID(),
    dataKey: {
      data_key: TEST_BYOK_DATA_KEY,
      wrapped_dek: 'wrapped',
      kms_key_id: 'alias/test',
      kms_key_version: '1',
    },
  });
}
