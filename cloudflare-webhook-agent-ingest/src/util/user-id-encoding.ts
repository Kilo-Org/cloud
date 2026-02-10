/**
 * OAuth user IDs like "oauth/google:123" contain "/" which breaks URL path routing.
 * For these IDs we base64url-encode the value and prefix with "o-" so the receiver
 * knows to decode. Plain UUIDs pass through unchanged for backward compatibility.
 */

/** Encode a userId for use in a URL path segment. */
export function encodeUserIdForPath(userId: string): string {
  if (!userId.includes('/')) return userId;
  const bytes = new TextEncoder().encode(userId);
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `o-${base64url}`;
}

/** Decode a userId extracted from a URL path segment. */
export function decodeUserIdFromPath(encoded: string): string {
  if (!encoded.startsWith('o-')) return encoded;
  try {
    const base64url = encoded.slice(2);
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return encoded;
  }
}
