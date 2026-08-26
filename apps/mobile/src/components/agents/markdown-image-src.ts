/**
 * Resolves the final source URI for a confirmed markdown image. Today the URI
 * passes through unchanged; a later slice replaces the body with a privacy
 * proxy so the image load never touches the device directly.
 */
export function resolveMarkdownImageSrc(uri: string): string {
  return uri;
}
