import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { truncateUtf8, utf8ByteLength } from './utf8-utils';

const MAX_CACHE_FILENAME_BYTES = 255;

export type ShareRemoteFileReason = 'sharing-unavailable' | 'download-failed';

export class ShareRemoteFileError extends Error {
  readonly reason: ShareRemoteFileReason;

  constructor(reason: ShareRemoteFileReason) {
    super(reason);
    this.name = 'ShareRemoteFileError';
    this.reason = reason;
  }
}

export type MaterializedRemoteFile = {
  uri: string;
  delete: () => void;
};

export function getShareRemoteFileReason(error: unknown): ShareRemoteFileReason | null {
  if (error instanceof ShareRemoteFileError) {
    return error.reason;
  }
  return null;
}

async function materializeRemoteFile({
  url,
  cacheDirectoryName,
  cacheFilename,
}: {
  url: string;
  cacheDirectoryName: string;
  cacheFilename: string;
}): Promise<MaterializedRemoteFile> {
  try {
    const directory = new Directory(Paths.cache, cacheDirectoryName);
    directory.create({ idempotent: true, intermediates: true });

    const file = new File(directory, cacheFilename);
    const downloaded = await File.downloadFileAsync(url, file, { idempotent: true });
    return {
      uri: downloaded.uri,
      delete: () => {
        downloaded.delete();
      },
    };
  } catch (error) {
    if (error instanceof ShareRemoteFileError) {
      throw error;
    }
    throw new ShareRemoteFileError('download-failed');
  }
}

export async function downloadRemoteFile({
  url,
  cacheDirectoryName,
  cacheFilename,
}: {
  url: string;
  cacheDirectoryName: string;
  cacheFilename: string;
}): Promise<MaterializedRemoteFile> {
  const materialized = await materializeRemoteFile({ url, cacheDirectoryName, cacheFilename });
  return materialized;
}

export async function shareLocalFile(
  localUri: string,
  options?: { mimeType?: string }
): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new ShareRemoteFileError('sharing-unavailable');
  }

  await Sharing.shareAsync(
    localUri,
    options?.mimeType ? { mimeType: options.mimeType } : undefined
  );
}

export async function shareMaterializedRemoteFile(
  file: MaterializedRemoteFile,
  shareFile: (uri: string) => Promise<void> = shareLocalFile
): Promise<void> {
  try {
    await shareFile(file.uri);
    if (Platform.OS !== 'android') {
      file.delete();
    }
  } catch (error) {
    file.delete();
    throw error;
  }
}

export async function shareRemoteFile({
  url,
  cacheDirectoryName,
  cacheKey,
  filename,
}: {
  url: string;
  cacheDirectoryName: string;
  cacheKey: string;
  filename: string;
}): Promise<void> {
  const materialized = await materializeRemoteFile({
    url,
    cacheDirectoryName,
    cacheFilename: getSafeCacheFilename({ id: cacheKey, filename }),
  });
  await shareMaterializedRemoteFile(materialized);
}

export function getSafeCacheFilename({ id, filename }: { id: string; filename: string }): string {
  const prefix = `${safePathSegment(id)}-`;
  const filenameBudget = MAX_CACHE_FILENAME_BYTES - utf8ByteLength(prefix);

  if (filenameBudget <= 0) {
    return truncateUtf8(prefix, MAX_CACHE_FILENAME_BYTES);
  }

  return `${prefix}${boundFilenameSegment(safePathSegment(filename), filenameBudget)}`;
}

function safePathSegment(value: string): string {
  const sanitized = value.trim().replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'attachment';
}

function boundFilenameSegment(filename: string, maxBytes: number): string {
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

function getExtension(filename: string): string {
  const extensionStart = filename.lastIndexOf('.');
  if (extensionStart <= 0 || extensionStart === filename.length - 1) {
    return '';
  }

  return filename.slice(extensionStart);
}
