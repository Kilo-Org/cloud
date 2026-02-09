const OAUTH_ID_PREFIX = 'oauth/';
const OAUTH_ENCODED_PREFIX = 'o-';

export function encodeWebhookUserIdSegment(userId: string): string {
  if (!userId.startsWith(OAUTH_ID_PREFIX)) {
    return userId;
  }
  return `${OAUTH_ENCODED_PREFIX}${base64UrlEncode(userId)}`;
}

export function decodeWebhookUserIdSegment(segment: string): string {
  if (!segment.startsWith(OAUTH_ENCODED_PREFIX)) {
    return segment;
  }
  const encoded = segment.slice(OAUTH_ENCODED_PREFIX.length);
  const decoded = base64UrlDecode(encoded);
  if (!decoded || !decoded.startsWith(OAUTH_ID_PREFIX)) {
    return segment;
  }
  return decoded;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4;
    const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
    const decoded = atob(padded);
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
