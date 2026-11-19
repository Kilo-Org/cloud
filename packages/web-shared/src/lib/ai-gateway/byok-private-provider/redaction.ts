import {
  isByokPrivateProviderId,
  type ByokPrivateProviderCredentials,
} from '@kilocode/db/schema-types';
import { parseByokPrivateProviderCredentials } from '@kilocode/web-shared/lib/ai-gateway/byok-private-provider';

/** The secret values in private provider credentials, which an upstream may echo in an error. */
export function byokPrivateProviderCredentialSecrets(
  credentials: ByokPrivateProviderCredentials
): string[] {
  switch (credentials.type) {
    case 'api_key':
    case 'x-api-key':
      return [credentials.api_key];
    case 'aws_bedrock':
      return [credentials.access_key_id, credentials.secret_access_key];
    case 'service_account':
      return [credentials.private_key_id, credentials.private_key];
  }
}

/**
 * The secrets a route to an organization's private provider sends: its stored credentials and the
 * upstream API key resolved from them. Null for any other route.
 */
export function byokPrivateProviderRouteSecrets(route: {
  provider: { apiKey: string };
  userByok: ReadonlyArray<{ providerId: string; decryptedAPIKey: string }> | null;
}): string[] | null {
  const keys = route.userByok?.filter(key => isByokPrivateProviderId(key.providerId)) ?? [];
  if (keys.length === 0) return null;
  const secrets = keys.flatMap(key => {
    const credentials = parseByokPrivateProviderCredentials(key.decryptedAPIKey);
    return credentials ? byokPrivateProviderCredentialSecrets(credentials) : [];
  });
  return [...new Set([...secrets, route.provider.apiKey])].filter(Boolean);
}

const REDACTED = '[redacted]';
/** Bounds the work of redaction, which scales with the text length. */
const MAX_REDACTED_TEXT_LENGTH = 4_000;
const MIN_MASKED_PREFIX_LENGTH = 8;
const MIN_MASKED_SUFFIX_LENGTH = 4;

/** The values to remove for one secret: all of it, and the ends upstreams show of a masked key. */
function secretFragments(secret: string): string[] {
  const fragments = [secret];
  if (secret.length <= MAX_REDACTED_TEXT_LENGTH / 16) {
    for (let length = secret.length - 1; length >= MIN_MASKED_PREFIX_LENGTH; length--) {
      fragments.push(secret.slice(0, length));
    }
    for (let length = secret.length - 1; length >= MIN_MASKED_SUFFIX_LENGTH; length--) {
      fragments.push(secret.slice(-length));
    }
  }
  return fragments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text`, cut to a bounded length, without the secrets, or the beginning or end of one, as an
 * upstream may echo them.
 */
export function redactByokPrivateProviderSecrets(text: string, secrets: readonly string[]): string {
  const fragments = [...new Set(secrets.filter(Boolean).flatMap(secretFragments))].sort(
    (a, b) => b.length - a.length
  );
  const bounded = text.slice(0, MAX_REDACTED_TEXT_LENGTH);
  if (fragments.length === 0) return bounded;
  // One pass, longest fragment first, so a replacement is never matched again.
  const pattern = new RegExp(fragments.map(fragment => escapeRegExp(fragment)).join('|'), 'g');
  return bounded.replace(pattern, REDACTED);
}
