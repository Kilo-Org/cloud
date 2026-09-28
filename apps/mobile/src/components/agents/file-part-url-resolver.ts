import { type FilePart } from '@kilocode/cloud-agent-sdk';
import { useEffect } from 'react';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { trpcClient } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

import {
  clearFilePartRenewing,
  clearFilePartResolveFailed,
  type FilePartCacheEntry,
  getFilePartCacheEntry,
  getFilePartCacheGeneration,
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
/** Floor before the next renew sweep: an entry whose renew keeps failing is
 *  retried no more often than every thirty seconds. */
const RENEW_INTERVAL_MS = 30_000;
/** Longest `setTimeout` delay the JS runtime accepts. A delay above 2^31 - 1 ms
 *  overflows and fires immediately, so a far-future expiry is re-checked here
 *  instead of busy-looping the sweep. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Part IDs with an on-demand presign in flight. Dedupes a StrictMode
 *  double-mount, a leave/reopen during the mutate, and the renewal sweep. */
const inFlight = new Map<string, () => boolean>();

// One module-level sweeper serves every mounted subscriber across the app.
let renewSubscribers = 0;
let renewTimer: ReturnType<typeof setTimeout> | undefined = undefined;

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
  entry: Readonly<FilePartCacheEntry & { attachmentRef: CloudAgentAttachmentRef }>,
  renewing = false
): Promise<boolean> {
  if (inFlight.get(partId)?.()) {
    return false;
  }
  const generation = getFilePartCacheGeneration();
  const epoch = currentAuthEpoch();
  const isCurrent = (): boolean =>
    generation === getFilePartCacheGeneration() &&
    isCurrentAuthEpoch(epoch) &&
    inFlight.get(partId) === isCurrent;
  inFlight.set(partId, isCurrent);
  if (renewing) {
    markFilePartRenewing(partId);
  }
  try {
    const result = await trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate({
      messageUuid: entry.attachmentRef.messageUuid,
      filename: entry.attachmentRef.filename,
    });
    if (!isCurrent()) {
      return false;
    }
    overwriteFilePartCacheEntry(partId, {
      url: result.signedUrl,
      mime: entry.mime,
      ...(entry.filename ? { filename: entry.filename } : {}),
      urlExpiresAt: parseTimestamp(result.expiresAt).getTime(),
    });
    // The trusted expiry moved: re-arm the sweep so the fresh URL is renewed
    // before it lapses instead of waiting on the old deadline.
    scheduleRenewSweep();
    return true;
  } catch {
    if (isCurrent()) {
      if (renewing) {
        clearFilePartRenewing(partId);
      } else {
        markFilePartResolveFailed(partId);
      }
    }
    return false;
  } finally {
    if (inFlight.get(partId) === isCurrent) {
      inFlight.delete(partId);
    }
  }
}

/** Milliseconds until a presigned entry is due for a renew. A missing or
 *  non-finite `urlExpiresAt` (an unparseable server `expiresAt` stored as NaN)
 *  is due at once: its URL has no trusted deadline to wait on, so the sweep
 *  re-presigns it instead of letting a NaN poison the earliest-due reduction or
 *  stranding the entry forever. */
function renewDueInMs(entry: FilePartCacheEntry, now: number): number {
  if (entry.urlExpiresAt === undefined || !Number.isFinite(entry.urlExpiresAt)) {
    return 0;
  }
  return entry.urlExpiresAt - now - RENEW_THRESHOLD_MS;
}

/** True when a presigned entry needs a renew now: a ref and URL exist and the
 *  expiry is missing, non-finite, or at/reached the renew threshold. */
function isRenewDue(entry: FilePartCacheEntry, now: number): boolean {
  return (
    entry.attachmentRef !== undefined && entry.url !== undefined && renewDueInMs(entry, now) <= 0
  );
}

/**
 * Delay until the earliest entry is due for a renew, floored at
 * RENEW_INTERVAL_MS, or null when no cached entry carries both an attachment
 * ref and a URL (nothing to renew). `renewDueInMs` never returns NaN, so one
 * malformed expiry cannot swallow a later entry's deadline or arm a ~1 ms
 * timeout that re-schedules the sweep forever.
 */
function nextRenewDelayMs(now: number): number | null {
  let soonest: number | undefined = undefined;
  for (const { entry } of listFilePartCacheEntries()) {
    if (entry.attachmentRef !== undefined && entry.url !== undefined) {
      const dueIn = renewDueInMs(entry, now);
      soonest = soonest === undefined || dueIn < soonest ? dueIn : soonest;
    }
  }
  return soonest === undefined ? null : Math.max(RENEW_INTERVAL_MS, soonest);
}

/** Re-presign every cached entry that is due now and return the in-flight
 *  renewals so the sweep can re-arm once they settle. */
function renewDueEntries(): Promise<boolean>[] {
  const now = Date.now();
  const renewals: Promise<boolean>[] = [];
  for (const { partId, entry } of listFilePartCacheEntries()) {
    const ref = entry.attachmentRef;
    if (ref !== undefined && isRenewDue(entry, now)) {
      renewals.push(presignAttachment(partId, { ...entry, attachmentRef: ref }, true));
    }
  }
  return renewals;
}

/**
 * Run one sweep, then re-arm: a successful renew moves the deadline out to the
 * new far-future expiry, a failed one leaves the entry due at the 30 s floor.
 */
async function runRenewSweep(): Promise<void> {
  const renewals = renewDueEntries();
  if (renewals.length > 0) {
    await Promise.allSettled(renewals);
  }
  scheduleRenewSweep();
}

/**
 * Arm the single shared timeout at the earliest due renew, replacing any armed
 * handle. No subscriber and no ref+URL entry both mean no timer at all.
 */
function scheduleRenewSweep(): void {
  if (renewTimer !== undefined) {
    clearTimeout(renewTimer);
    renewTimer = undefined;
  }
  if (renewSubscribers === 0) {
    return;
  }
  const delay = nextRenewDelayMs(Date.now());
  if (delay === null) {
    return;
  }
  renewTimer = setTimeout(
    () => {
      renewTimer = undefined;
      void runRenewSweep();
    },
    Math.min(delay, MAX_TIMER_DELAY_MS)
  );
}

function startRenewTimer(): void {
  scheduleRenewSweep();
}

function stopRenewTimer(): void {
  if (renewTimer !== undefined) {
    clearTimeout(renewTimer);
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
    if (!attachmentRef) {
      return;
    }
    void presignAttachment(part.id, {
      attachmentRef,
      mime: part.mime,
      filename: part.filename,
    });
  }, [part.id, part.url, part.mime, part.filename, cached]);

  // Renew-on-read: kick a due re-presign when this subscriber first mounts.
  // Deps are deliberately scoped to the part id so a failed renew (which only
  // clears `renewing`) never re-triggers a tight retry loop; the next sweep or
  // a fresh mount retries instead.
  useEffect(() => {
    const entry = getFilePartCacheEntry(part.id);
    const attachmentRef = entry?.attachmentRef;
    if (!entry || !attachmentRef || entry.url === undefined) {
      return;
    }
    if (!isRenewDue(entry, Date.now())) {
      return;
    }
    void presignAttachment(part.id, { ...entry, attachmentRef }, true);
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
  const refreshed = await presignAttachment(partId, { ...entry, attachmentRef: ref }, true);
  return refreshed;
}

export function __resetFilePartUrlResolverForTests(): void {
  inFlight.clear();
  renewSubscribers = 0;
  stopRenewTimer();
}
