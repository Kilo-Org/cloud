import { type FilePart } from '@kilocode/cloud-agent-sdk';
import { useEffect } from 'react';

import { trpcClient } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

import {
  clearFilePartRenewing,
  clearFilePartResolveFailed,
  type FilePartCacheEntry,
  getFilePartCacheEntry,
  isUsableFilePartUrl,
  listFilePartCacheEntries,
  markFilePartRenewing,
  markFilePartResolveFailed,
  overwriteFilePartCacheEntry,
  useFilePartCache,
} from './file-part-cache';
import { type CloudAgentAttachmentRef, parseCloudAgentAttachmentUrl } from './file-part-preview';

/** Start a renew when the presigned lifetime drops under two minutes. */
const RENEW_THRESHOLD_MS = 120_000;
/** Sweep the cache for near-expiry URLs every thirty seconds. */
const RENEW_INTERVAL_MS = 30_000;

/** Part IDs with an on-demand presign in flight. Dedupes a StrictMode
 *  double-mount, a leave/reopen during the mutate, and the renewal sweep. */
const inFlight = new Set<string>();

// One module-level sweeper serves every mounted subscriber across the app.
let renewSubscribers = 0;
let renewTimer: ReturnType<typeof setInterval> | undefined = undefined;

export type ResolvedFilePartUrl = {
  status: 'ready' | 'resolving' | 'unavailable' | 'error';
  // set only when status === 'ready'
  url?: string;
  // set whenever a ref is known
  attachmentRef?: CloudAgentAttachmentRef;
  // true while a renew is in flight and the last-good URL is still shown
  renewing?: boolean;
  // set only when status === 'error'
  retry?: () => void;
};

/** Presign one attachment and store the signed URL with its expiry. */
async function presignAttachment(
  partId: string,
  ref: CloudAgentAttachmentRef,
  entry: Readonly<{ mime: string; filename?: string }>
): Promise<void> {
  const result = await trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate({
    messageUuid: ref.messageUuid,
    filename: ref.filename,
  });
  overwriteFilePartCacheEntry(partId, {
    url: result.signedUrl,
    mime: entry.mime,
    ...(entry.filename ? { filename: entry.filename } : {}),
    urlExpiresAt: parseTimestamp(result.expiresAt).getTime(),
  });
}

/** True when a presigned entry needs a renew now: a ref and URL exist and the
 *  expiry is missing (old entry) or under the renew threshold. */
function isRenewDue(entry: FilePartCacheEntry, now: number): boolean {
  return (
    entry.attachmentRef !== undefined &&
    entry.url !== undefined &&
    (entry.urlExpiresAt === undefined || entry.urlExpiresAt - now < RENEW_THRESHOLD_MS)
  );
}

/** Re-presign a cached attachment ref, keeping the last-good URL visible. */
async function renewAttachment(
  partId: string,
  ref: CloudAgentAttachmentRef,
  entry: Readonly<{ mime: string; filename?: string }>
): Promise<void> {
  if (inFlight.has(partId)) {
    return;
  }
  inFlight.add(partId);
  markFilePartRenewing(partId);
  try {
    await presignAttachment(partId, ref, entry);
  } catch {
    clearFilePartRenewing(partId);
  } finally {
    inFlight.delete(partId);
  }
}

function renewDueEntries(): void {
  const now = Date.now();
  for (const { partId, entry } of listFilePartCacheEntries()) {
    const ref = entry.attachmentRef;
    if (ref !== undefined && !inFlight.has(partId) && isRenewDue(entry, now)) {
      void renewAttachment(partId, ref, entry);
    }
  }
}

function startRenewTimer(): void {
  if (renewTimer !== undefined) {
    return;
  }
  renewTimer = setInterval(renewDueEntries, RENEW_INTERVAL_MS);
}

function stopRenewTimer(): void {
  if (renewTimer !== undefined) {
    clearInterval(renewTimer);
    renewTimer = undefined;
  }
}

/**
 * Resolve a usable URL for a FilePart. A captured `http(s)`/`data:` URL (or a
 * cached one) is used directly. A cloud-agent sandbox `file://` attachment is
 * presigned on demand via `getAttachmentDownloadUrl`; a near-expiry signed URL
 * is re-presigned in the background so the last-good URL never flickers.
 * Failure state lives in the cache store so a remounted instance sees a failed
 * presign instead of a stuck `resolving`.
 */
export function useResolvedFilePartUrl(part: FilePart): ResolvedFilePartUrl {
  const cached = useFilePartCache(part.id);

  const url = cached?.url ?? (isUsableFilePartUrl(part.url) ? part.url : undefined);
  const ref = cached?.attachmentRef ?? parseCloudAgentAttachmentUrl(part.url);
  const failed = cached?.resolveFailed === true;
  const renewing = cached?.renewing === true;

  // Start the shared sweeper with the first subscriber, stop with the last.
  useEffect(() => {
    renewSubscribers += 1;
    startRenewTimer();
    return () => {
      renewSubscribers -= 1;
      if (renewSubscribers === 0) {
        stopRenewTimer();
      }
    };
  }, []);

  useEffect(() => {
    const entry = getFilePartCacheEntry(part.id);
    if (entry?.resolveFailed) {
      return;
    }
    if (entry?.url !== undefined) {
      // A resolved URL already exists; the renewal sweep and the read-path
      // effect below own re-presigning, so never drop the last URL here.
      return;
    }
    const attachmentRef = entry?.attachmentRef ?? parseCloudAgentAttachmentUrl(part.url);
    if (!attachmentRef || inFlight.has(part.id)) {
      return;
    }
    // First presign: no URL yet, so nothing to keep on failure.
    inFlight.add(part.id);
    void (async () => {
      try {
        await presignAttachment(part.id, attachmentRef, {
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

  // Renew-on-read: kick a due re-presign when this subscriber first mounts.
  // Deps are deliberately scoped to the part id so a failed renew (which only
  // clears `renewing`) never re-triggers a tight retry loop; the next sweep or
  // a fresh mount retries instead.
  useEffect(() => {
    const entry = getFilePartCacheEntry(part.id);
    const attachmentRef = entry?.attachmentRef;
    if (!entry || !attachmentRef || entry.url === undefined || inFlight.has(part.id)) {
      return;
    }
    if (!isRenewDue(entry, Date.now())) {
      return;
    }
    void renewAttachment(part.id, attachmentRef, entry);
  }, [part.id]);

  if (url !== undefined) {
    return {
      status: 'ready',
      url,
      ...(ref ? { attachmentRef: ref } : {}),
      ...(renewing ? { renewing: true } : {}),
    };
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
  if (inFlight.has(partId)) {
    return false;
  }
  markFilePartRenewing(partId);
  inFlight.add(partId);
  try {
    await presignAttachment(partId, ref, entry);
    return true;
  } catch {
    clearFilePartRenewing(partId);
    return false;
  } finally {
    inFlight.delete(partId);
  }
}

/** Test-only: clear the in-flight set, sweeper, and subscriber count. */
export function __resetFilePartUrlResolverForTests(): void {
  inFlight.clear();
  renewSubscribers = 0;
  stopRenewTimer();
}
