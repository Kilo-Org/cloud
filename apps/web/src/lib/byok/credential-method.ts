import { getStructuredCredentialKind } from '@kilocode/app-shared/byok-credentials';

/** The authentication method a stored Bedrock credential carries. */
export type StoredBedrockMethod = 'apiKey' | 'accessKeys';

/**
 * The method a stored Bedrock credential was saved with, or null for another
 * provider, an unparseable credential, or neither shape. Reads only the field
 * names, so the credential value never leaves the server.
 */
export function storedBedrockMethod(
  providerId: string,
  credential: string
): StoredBedrockMethod | null {
  if (getStructuredCredentialKind(providerId) !== 'bedrock') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  if ('accessKeyId' in parsed && isNonEmptyString(parsed.accessKeyId)) {
    return 'accessKeys';
  }
  if ('apiKey' in parsed && isNonEmptyString(parsed.apiKey)) {
    return 'apiKey';
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
