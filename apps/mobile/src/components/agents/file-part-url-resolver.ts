import { type FilePart } from '@kilocode/cloud-agent-sdk';
import { useEffect } from 'react';

import { trpcClient } from '@/lib/trpc';

import {
  clearFilePartResolveFailed,
  getFilePartCacheEntry,
  isUsableFilePartUrl,
  markFilePartResolveFailed,
  overwriteFilePartCacheEntry,
  useFilePartCache,
} from './file-part-cache';
import { type CloudAgentAttachmentRef, parseCloudAgentAttachmentUrl } from './file-part-preview';

/** Part IDs with an on-demand presign in flight. Dedupes a StrictMode
 *  double-mount and a leave/reopen during the mutate. */
const inFlight = new Set<string>();

export type ResolvedFilePartUrl = {
  status: 'ready' | 'resolving' | 'unavailable' | 'error';
  // set only when status === 'ready'
  url?: string;
  // set whenever a ref is known
  attachmentRef?: CloudAgentAttachmentRef;
  // set only when status === 'error'
  retry?: () => void;
};

/**
 * Resolve a usable URL for a FilePart. A captured `http(s)`/`data:` URL (or a
 * cached one) is used directly. A cloud-agent sandbox `file://` attachment is
 * presigned on demand via `getAttachmentDownloadUrl`. Failure state lives in
 * the cache store so a remounted instance sees a failed presign instead of a
 * stuck `resolving`.
 */
export function useResolvedFilePartUrl(part: FilePart): ResolvedFilePartUrl {
  const cached = useFilePartCache(part.id);

  const url = cached?.url ?? (isUsableFilePartUrl(part.url) ? part.url : undefined);
  const ref = cached?.attachmentRef ?? parseCloudAgentAttachmentUrl(part.url);
  const failed = cached?.resolveFailed === true;

  useEffect(() => {
    const entry = getFilePartCacheEntry(part.id);
    if (entry?.url || entry?.resolveFailed) {
      return;
    }
    const attachmentRef = entry?.attachmentRef ?? parseCloudAgentAttachmentUrl(part.url);
    if (!attachmentRef || inFlight.has(part.id)) {
      return;
    }
    inFlight.add(part.id);
    void (async () => {
      try {
        const result = await trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate({
          messageUuid: attachmentRef.messageUuid,
          filename: attachmentRef.filename,
        });
        overwriteFilePartCacheEntry(part.id, {
          url: result.signedUrl,
          mime: part.mime,
          filename: part.filename,
        });
      } catch {
        markFilePartResolveFailed(part.id);
      } finally {
        inFlight.delete(part.id);
      }
    })();
  }, [part.id, part.url, part.mime, part.filename, cached]);

  if (url !== undefined) {
    return { status: 'ready', url, ...(ref ? { attachmentRef: ref } : {}) };
  }
  if (!ref) {
    return { status: 'unavailable' };
  }
  if (failed) {
    return {
      status: 'error',
      attachmentRef: ref,
      retry: () => {
        clearFilePartResolveFailed(part.id);
      },
    };
  }
  return { status: 'resolving', attachmentRef: ref };
}

/**
 * Re-presign a cached attachment ref and swap the entry's URL. Returns false
 * (never throws) when there is no entry, no ref, or the presign fails.
 */
export async function refreshFilePartUrl(partId: string): Promise<boolean> {
  const entry = getFilePartCacheEntry(partId);
  const ref = entry?.attachmentRef;
  if (!entry || !ref) {
    return false;
  }
  try {
    const result = await trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate({
      messageUuid: ref.messageUuid,
      filename: ref.filename,
    });
    overwriteFilePartCacheEntry(partId, {
      url: result.signedUrl,
      mime: entry.mime,
      ...(entry.filename ? { filename: entry.filename } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** Test-only: clear the in-flight set between cases. */
export function __resetFilePartUrlResolverForTests(): void {
  inFlight.clear();
}
