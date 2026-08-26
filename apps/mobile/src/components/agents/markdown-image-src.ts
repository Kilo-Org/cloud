import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { API_BASE_URL } from '@/lib/config';

/**
 * Request header carrying the source URL to the media proxy. The source URL
 * stays out of the query string so it never reaches a server access log.
 */
export const MEDIA_SOURCE_HEADER = 'x-media-source-url';

// The query carries only an opaque per-session id so the proxy URI stays
// unique per source image and the image cache does not collide.
// ponytail: unbounded map; add eviction only if a session ever renders enough
// distinct images for it to matter.
const sourceIds = new Map<string, string>();
let nextSourceId = 0;

function assignSourceId(uri: string): string {
  nextSourceId += 1;
  const id = `m${(nextSourceId - 1).toString(36)}`;
  sourceIds.set(uri, id);
  return id;
}

/**
 * Resolves the final source URI for a confirmed markdown image: the media
 * proxy URL on the API base. The image loads through the proxy, so the device
 * never fetches the source host directly. Pair it with
 * `buildMarkdownImageHeaders`, which carries the source URL and the token.
 */
export function resolveMarkdownImageSrc(uri: string): string {
  const id = sourceIds.get(uri) ?? assignSourceId(uri);
  return `${API_BASE_URL}/api/media/proxy?id=${id}`;
}

/**
 * Drops the id held for a source URL so the next resolve returns a fresh proxy
 * URI. A retry then bypasses any client image cache keyed on the old URI,
 * including one that memoized a failed load.
 */
export function refreshMarkdownImageSrc(uri: string): void {
  sourceIds.delete(uri);
}

/** Test hook: forgets every assigned id so ids are predictable per test. */
export function clearMarkdownImageSrcMemory(): void {
  sourceIds.clear();
  nextSourceId = 0;
}

export function buildMarkdownImageHeaders(token: string, uri: string) {
  return { ...buildAuthHeaders(token), [MEDIA_SOURCE_HEADER]: uri } satisfies Record<
    string,
    string
  >;
}
