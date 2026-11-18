import { base64urlToBytes, bytesToBase64url } from './base64url';

/**
 * OAuth user IDs like "oauth/google:123" contain "/" which breaks URL path routing.
 * For these IDs we base64url-encode the value and prefix with "o-" so the receiver
 * knows to decode. Plain UUIDs pass through unchanged for backward compatibility.
 */

/** Encode a userId for use in a URL path segment. */
export function encodeUserIdForPath(userId: string): string {
  if (!userId.includes('/')) return userId;
  return `o-${bytesToBase64url(new TextEncoder().encode(userId))}`;
}

/** Decode a userId extracted from a URL path segment. */
export function decodeUserIdFromPath(encoded: string): string {
  if (!encoded.startsWith('o-')) return encoded;
  try {
    return new TextDecoder().decode(base64urlToBytes(encoded.slice(2)));
  } catch {
    return encoded;
  }
}
