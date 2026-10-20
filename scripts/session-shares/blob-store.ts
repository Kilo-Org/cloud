import type { ShareBlobFilename } from './blob-filenames';
import type { BlobStore } from './cleanup-core';

type DeleteBlobs = (
  sessionId: string,
  blobs: { folderName: 'shared-sessions'; filename: ShareBlobFilename }[],
  options?: { signal?: AbortSignal }
) => Promise<void>;

export function createBlobStore(deleteBlobs: DeleteBlobs): BlobStore {
  return {
    deleteShareBlobs(shareId, filenames, options) {
      return deleteBlobs(
        shareId,
        filenames.map(filename => ({ folderName: 'shared-sessions', filename })),
        options
      );
    },
  };
}

export async function createR2BlobStore(): Promise<BlobStore> {
  const { deleteBlobs } = await import('../../apps/web/src/lib/r2/cli-sessions');
  return createBlobStore(deleteBlobs);
}
