import { truncateUtf8, utf8ByteLength } from './utf8-utils';

/**
 * The per-component byte limit of the cache filesystem (APFS, ext4, and the
 * Android internal storage all cap one name at 255 bytes). A name longer than
 * this cannot be created, so a copy into the cache would throw.
 */
export const MAX_CACHE_FILENAME_BYTES = 255;

export function boundFilenameSegment(filename: string, maxBytes: number): string {
  if (utf8ByteLength(filename) <= maxBytes) {
    return filename;
  }

  const extension = getExtension(filename);
  const extensionBytes = utf8ByteLength(extension);
  if (extension.length > 0 && extensionBytes < maxBytes) {
    const stem = filename.slice(0, -extension.length);
    const truncatedStem = truncateUtf8(stem, maxBytes - extensionBytes);
    if (truncatedStem.length > 0) {
      return `${truncatedStem}${extension}`;
    }
  }

  return truncateUtf8(filename, maxBytes);
}

export function getExtension(filename: string): string {
  const extensionStart = filename.lastIndexOf('.');
  if (extensionStart <= 0 || extensionStart === filename.length - 1) {
    return '';
  }

  return filename.slice(extensionStart);
}
