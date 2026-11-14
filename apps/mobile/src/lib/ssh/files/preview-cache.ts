import { Directory, File, Paths } from 'expo-file-system';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

/*
 * Preview copies live in their own directory: a download or share copy under
 * `ssh-files` outlives the screen, so the startup sweep must never reach it.
 */
const PREVIEW_CACHE_DIRECTORY = 'ssh-file-previews';

const liveUris = new Set<string>();
let counter = 0;

export type PreviewCacheFile = Readonly<{
  uri: string;
  release: () => void;
}>;

function previewDirectory(): Directory {
  return new Directory(Paths.cache, PREVIEW_CACHE_DIRECTORY);
}

function deletePreviewFile(uri: string): void {
  liveUris.delete(uri);
  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // A delete the platform refused is left for the next startup sweep.
  }
}

/**
 * Reserves a cache path for one preview. Every call gets a new name, so a
 * download still in flight can never overwrite the preview on screen.
 */
export function allocatePreviewCache(name: string): PreviewCacheFile {
  counter += 1;
  const directory = previewDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const uri = new File(
    directory,
    getSafeCacheFilename({ id: `preview-${Date.now()}-${counter}`, filename: name })
  ).uri;
  liveUris.add(uri);
  return {
    uri,
    release: () => {
      deletePreviewFile(uri);
    },
  };
}

/**
 * Drops preview copies an earlier mount left behind. A live preview is kept so
 * sweeping one screen never blanks a preview another screen still shows.
 */
export function sweepPreviewCache(): void {
  try {
    const directory = previewDirectory();
    if (!directory.exists) {
      return;
    }
    for (const entry of directory.list()) {
      if (!liveUris.has(entry.uri)) {
        entry.delete();
      }
    }
  } catch {
    // A failed sweep leaves the copies for the next startup.
  }
}
