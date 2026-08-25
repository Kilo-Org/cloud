import { API_BASE_URL } from '@/lib/config';

/**
 * Resolves the final source URI for a confirmed markdown image: the media proxy
 * URL on the API base. The image loads through the proxy, so the device never
 * fetches the source host directly.
 */
export function resolveMarkdownImageSrc(uri: string): string {
  return `${API_BASE_URL}/api/media/proxy?url=${encodeURIComponent(uri)}`;
}
