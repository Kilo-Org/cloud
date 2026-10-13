import { getFilename } from './tool-card-utils';

/**
 * Resolves the final source URI for a confirmed markdown image. Today the URI
 * passes through unchanged; a later slice replaces the body with a privacy
 * proxy so the image load never touches the device directly.
 */
export function resolveMarkdownImageSrc(uri: string): string {
  return uri;
}

/** The image viewer's header name: alt text, else the URL's file name, else "image". */
export function markdownImageFilename(uri: string, alt: string): string {
  return alt || (uri.startsWith('http') ? getFilename(uri.split('?')[0] ?? '') : '') || 'image';
}
