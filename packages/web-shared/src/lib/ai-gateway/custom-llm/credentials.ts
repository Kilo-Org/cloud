import {
  CustomLlmCredentialsSchema,
  type CustomLlmCredentials,
  type EncryptedData,
} from '@kilocode/db/schema-types';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';

export function decryptCustomLlmCredentials(encrypted: EncryptedData): CustomLlmCredentials | null {
  const decrypted = decryptApiKey(encrypted, BYOK_ENCRYPTION_KEY);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    return null;
  }
  const parsed = CustomLlmCredentialsSchema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}

/** The gateway sends the proxy secret to `base_url`, so the secure proxy must be reached over HTTPS. */
export function hasInsecureSecureProxyUrl(baseUrl: string, credentials: CustomLlmCredentials) {
  return credentials.type === 'secure_proxy' && new URL(baseUrl).protocol !== 'https:';
}

export const INSECURE_SECURE_PROXY_URL_MESSAGE =
  'base_url must use https when the credentials route through the secure proxy';
