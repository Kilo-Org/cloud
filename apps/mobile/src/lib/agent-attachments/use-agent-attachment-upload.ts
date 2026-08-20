/* eslint-disable max-lines -- the upload hook owns the candidate classification, metadata strip, deferred upload, send-admission state machine, and cancel-handle registration in one cohesive module */
import * as Crypto from 'expo-crypto';
import * as Sentry from '@sentry/react-native';
import { File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { createFrameCoalescer } from '@/lib/coalesce-frame';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import {
  canAddAttachments,
  classifyAttachment,
  describeClassificationFailure,
  mimeForExtension,
} from '@/lib/agent-attachments/validate';
import {
  type AgentAttachment,
  type AgentAttachmentSubmissionPayload,
  type AgentAttachmentWire,
  buildSubmissionPayload,
  buildWirePayload,
  classifyUploadFailure,
  hasAnyFailedAttachment,
  isAnyAttachmentUploading,
} from '@/lib/agent-attachments/agent-attachment-types';
import {
  stripImageMetadata,
  strippedExtension,
} from '@/lib/agent-attachments/strip-image-metadata';
import {
  describeTerminalReason,
  measureLocalSize,
  normalizeFilename,
  uploadOne,
} from '@/lib/agent-attachments/upload-task';

// Re-export only the types consumers import from this module.
export type { AgentAttachment, AgentAttachmentSubmissionPayload, AgentAttachmentWire };

export type AgentAttachmentCandidate = {
  name: string;
  uri: string;
  mimeType?: string;
  size?: number;
};

/**
 * Delete a cache-owned file after its upload is cancelled or its chip is
 * removed. A picker-provided URI is not owned by the app and is never deleted.
 * Best-effort: a failed delete is reported to Sentry and never surfaces as an
 * upload error.
 */
function deleteCacheOwnedFile(localUri: string): void {
  if (!localUri.startsWith(Paths.cache.uri)) {
    return;
  }
  try {
    const file = new File(localUri);
    if (file.exists) {
      file.delete();
    }
  } catch (error) {
    Sentry.captureException(error);
  }
}

/**
 * Run a cancel handle and swallow its rejection. Cancellation is best-effort
 * and must never surface as an unhandled rejection.
 */
async function runCancellation(handle: () => Promise<void>): Promise<void> {
  try {
    await handle();
  } catch {
    // Best-effort cancellation.
  }
}

type UseAgentAttachmentUploadOptions = {
  organizationId?: string;
};

export type UploadPendingResult =
  | {
      ok: true;
      wire: AgentAttachmentWire | undefined;
      submission: AgentAttachmentSubmissionPayload | undefined;
    }
  | { ok: false };

type UseAgentAttachmentUploadReturn = {
  attachments: AgentAttachment[];
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  reset: () => void;
  isUploading: boolean;
  hasFailedAttachments: boolean;
  /** Upload every pending/retryable chip and return the payloads, or `{ ok: false }`. */
  uploadPending: () => Promise<UploadPendingResult>;
};

type UploadRunResult =
  | { id: string; failed: false; remoteFilename: string; remoteKey: string }
  | { id: string; failed: true };

export function useAgentAttachmentUpload(
  options: UseAgentAttachmentUploadOptions = {}
): UseAgentAttachmentUploadReturn {
  const { organizationId } = options;
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  // Live mirror of `attachments` so `uploadPending` reads the current chip list
  // without waiting on a render. Written in every commit below.
  const attachmentsRef = useRef<AgentAttachment[]>([]);
  const pathRef = useRef<string>(Crypto.randomUUID());
  const messageUuidRef = useRef<string>(Crypto.randomUUID());
  const isMountedRef = useRef<boolean>(true);
  // Row 3.3 stale-outcome guard. `liveIdsRef` mirrors the current attachment
  // ids, so an in-flight upload for a removed chip — or for any chip cleared by
  // a reset — is invalidated synchronously; the async completion never observes
  // a stale `attachments` closure. `generationRef` covers only the window
  // before ids exist: a reset while candidate measurement is in flight.
  const generationRef = useRef(0);
  const liveIdsRef = useRef<Set<string>>(new Set());
  // Cancel handles for in-flight uploads, keyed by attachment id. Each handle
  // cancels the upload task and deletes a cache-owned partial file. The entry
  // is removed when the upload settles (in `startUpload`'s finally) or when a
  // cancel runs.
  const cancelHandlesRef = useRef(new Map<string, () => Promise<void>>());

  const cancelUpload = useCallback((id: string) => {
    const handle = cancelHandlesRef.current.get(id);
    if (!handle) {
      return;
    }
    cancelHandlesRef.current.delete(id);
    void runCancellation(handle);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    const handles = cancelHandlesRef.current;
    const liveIds = liveIdsRef.current;
    return () => {
      isMountedRef.current = false;
      // Invalidate the live ids before cancelling so a cancel-triggered
      // rejection in `uploadOne` is suppressed by the catch's `liveIdsRef`
      // guard: unmount must emit no toast and flip no state.
      liveIds.clear();
      // Cancel every in-flight upload on unmount.
      for (const id of handles.keys()) {
        cancelUpload(id);
      }
    };
  }, [cancelUpload]);

  // Single commit point: writes state AND the live ref mirror in one pass.
  const commitAttachments = useCallback(
    (updater: (current: AgentAttachment[]) => AgentAttachment[]) => {
      setAttachments(current => {
        const next = updater(current);
        attachmentsRef.current = next;
        return next;
      });
    },
    []
  );

  const updateAttachment = useCallback(
    (id: string, patch: Partial<AgentAttachment>) => {
      if (!isMountedRef.current) {
        return;
      }
      commitAttachments(current => {
        if (!current.some(item => item.id === id)) {
          // Keep the same array reference when the id is gone (removed or
          // reset) so a stale async update cannot replace the attachment list.
          return current;
        }
        return current.map(item => (item.id === id ? { ...item, ...patch } : item));
      });
    },
    [commitAttachments]
  );

  const startUpload = useCallback(
    // eslint-disable-next-line typescript-eslint/promise-function-async -- returns run()'s promise so callers control the timing
    (attachment: AgentAttachment, path: string): Promise<UploadRunResult> => {
      const run = async (): Promise<UploadRunResult> => {
        updateAttachment(attachment.id, {
          status: 'uploading',
          error: undefined,
          terminal: undefined,
          progress: 0,
        });
        const progressCoalescer = createFrameCoalescer<number | null>(progress => {
          updateAttachment(attachment.id, { progress });
        });
        // Register the cancel handle BEFORE the presign `await` so a
        // remove/reset/unmount during that window still deletes the
        // cache-owned file and blocks task creation after the signed URL
        // returns.
        let cancelled = false;
        let task: { cancelAsync: () => Promise<void> } | undefined = undefined;
        cancelHandlesRef.current.set(attachment.id, async () => {
          cancelled = true;
          progressCoalescer.cancel();
          try {
            if (task) {
              await task.cancelAsync();
            }
          } finally {
            deleteCacheOwnedFile(attachment.localUri);
          }
        });
        try {
          const { key } = await uploadOne({
            organizationId,
            attachmentId: attachment.id,
            path,
            extension: attachment.extension,
            contentType: attachment.mimeType,
            contentLength: attachment.size,
            localUri: attachment.localUri,
            onProgress: progress => {
              progressCoalescer.push(progress);
            },
            onTask: t => {
              task = t;
            },
            isCancelled: () => cancelled,
          });
          // Row 3.3 stale-outcome guard: a removed or reset upload must not
          // flip state or announce for the current composer. Ids are UUIDs, so
          // a cleared id can never come back. Unmount is suppressed separately
          // via `isMountedRef`.
          if (!liveIdsRef.current.has(attachment.id)) {
            return { id: attachment.id, failed: true };
          }
          // Drain any pending progress before the terminal flip so the chip
          // lands on `progress: 1` and never sticks at a stale percentage.
          progressCoalescer.flush();
          const remoteKey = key;
          const remoteFilename = key.split('/').at(-1) ?? '';
          updateAttachment(attachment.id, {
            status: 'uploaded',
            remoteFilename,
            remoteKey,
            progress: 1,
          });
          // Hook-owned success announcement (D19): the flip to terminal
          // success announces exactly once, and only while the composer is
          // still mounted. The chip is presentational and never announces.
          // `announceForA11y` swallows native failures, so it can never enter
          // the upload catch and turn success into a failure toast.
          if (isMountedRef.current) {
            announceForA11y('Attachment uploaded');
          }
          return { id: attachment.id, failed: false, remoteFilename, remoteKey };
        } catch (error) {
          if (!liveIdsRef.current.has(attachment.id)) {
            return { id: attachment.id, failed: true };
          }
          // Drain any pending progress before the terminal flip so the chip
          // lands on the error state and never sticks at a stale percentage.
          progressCoalescer.flush();
          const { retryable, reason } = classifyUploadFailure(error);
          updateAttachment(attachment.id, {
            status: 'error',
            error: retryable ? reason : describeTerminalReason(reason),
            terminal: !retryable,
            progress: null,
          });
          // Single announced toast per failed chip (D19). Terminal surfaces
          // its own chip copy so the toast only needs to echo the same intent.
          announcingToast.error(
            retryable ? `Failed to upload file: ${reason}` : describeTerminalReason(reason)
          );
          return { id: attachment.id, failed: true };
        } finally {
          // The upload settled (success or failure): drop the cancel handle so
          // a later remove/reset does not try to cancel a finished task.
          cancelHandlesRef.current.delete(attachment.id);
        }
      };
      return run();
    },
    [organizationId, updateAttachment]
  );

  const addCandidates = useCallback(
    async (candidates: AgentAttachmentCandidate[]) => {
      if (candidates.length === 0) {
        return;
      }
      const generation = generationRef.current;
      const limit = canAddAttachments(attachments.length, candidates.length);
      if (!limit.ok) {
        toast.error(`Maximum ${AGENT_ATTACHMENT_MAX_FILES} files allowed`);
        return;
      }
      const accepted = candidates.slice(0, limit.acceptedCount);
      if (limit.truncated) {
        toast.warning(
          `Only adding ${limit.acceptedCount} of ${candidates.length} files (max ${AGENT_ATTACHMENT_MAX_FILES})`
        );
      }

      // We pre-classify synchronously; the *measured* size comes from
      // `getInfoAsync`. Candidates that the picker reports as zero-size
      // (common on iOS) are re-measured before the size/empty rule fires.
      const measured = await Promise.all(
        accepted.map(async candidate => {
          const measuredSize = await measureLocalSize(candidate.uri);
          const size = measuredSize ?? candidate.size ?? 0;
          return { candidate, size };
        })
      );

      // Row 3.3 stale-outcome guard: a reset while measurement is pending
      // invalidates the captured generation, so the continuation must not
      // classify, add, or start uploads for the previous composer session.
      if (generationRef.current !== generation || !isMountedRef.current) {
        return;
      }

      const additions: AgentAttachment[] = [];
      for (const { candidate, size } of measured) {
        const classified = classifyAttachment({ name: candidate.name, size });
        if (!classified.ok) {
          toast.error(describeClassificationFailure(classified.reason));
        } else {
          let ext = classified.extension;
          let localUri = candidate.uri;
          let finalSize = classified.size;
          let localFileOwned = false;
          let metadataStripFailed = false;
          if (classified.kind === 'image') {
            // Strip EXIF/GPS/maker notes before measuring so `size` reflects
            // the stripped file. A failure keeps the original URI and marks
            // the chip so the composer can warn.
            // eslint-disable-next-line no-await-in-loop -- each candidate's strip must complete before its size is measured
            const strippedUri = await stripImageMetadata(candidate.uri, ext);
            if (strippedUri !== candidate.uri) {
              const newExt = strippedExtension(ext);
              ext = newExt;
              localUri = strippedUri;
              localFileOwned = true;
              // eslint-disable-next-line no-await-in-loop -- measure the stripped file before the next candidate
              const strippedSize = await measureLocalSize(strippedUri);
              finalSize = strippedSize !== null && strippedSize > 0 ? strippedSize : finalSize;
            } else {
              metadataStripFailed = true;
            }
          } else {
            // Documents come from `copyToCacheDirectory`, so the app owns the file.
            localFileOwned = true;
          }
          const filename = normalizeFilename(candidate.name, ext);
          additions.push({
            id: Crypto.randomUUID(),
            filename,
            kind: classified.kind,
            extension: ext,
            mimeType: mimeForExtension(ext),
            size: finalSize,
            localUri,
            localFileOwned,
            metadataStripFailed: metadataStripFailed || undefined,
            status: 'pending',
            progress: 0,
          });
        }
      }
      if (additions.length === 0) {
        return;
      }
      // Re-check the generation after the async strip/measure loop: a reset
      // during that window must drop the additions.
      // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- isMountedRef flips to false in the unmount cleanup, which can run during the awaited strip/measure work
      if (generationRef.current !== generation || !isMountedRef.current) {
        return;
      }
      commitAttachments(current => [...current, ...additions]);
      for (const addition of additions) {
        liveIdsRef.current.add(addition.id);
      }
    },
    [attachments.length, commitAttachments]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      cancelUpload(id);
      liveIdsRef.current.delete(id);
      const chip = attachmentsRef.current.find(item => item.id === id);
      if (chip?.localFileOwned) {
        deleteCacheOwnedFile(chip.localUri);
      }
      commitAttachments(current => current.filter(item => item.id !== id));
    },
    [cancelUpload, commitAttachments]
  );

  const retryAttachment = useCallback(
    (id: string) => {
      const attachment = attachments.find(item => item.id === id);
      if (!attachment || attachment.terminal) {
        // Terminal chips have no retry affordance; bail so a stray
        // tap cannot re-upload a server-rejected file.
        return;
      }
      void startUpload(attachment, pathRef.current);
    },
    [attachments, startUpload]
  );

  const reset = useCallback(() => {
    // Invalidate the generation before clearing state so a pending
    // candidate-measurement continuation observes the new generation
    // and drops its candidates instead of adding them post-reset.
    generationRef.current += 1;
    for (const id of liveIdsRef.current) {
      cancelUpload(id);
    }
    liveIdsRef.current.clear();
    for (const chip of attachmentsRef.current) {
      if (chip.localFileOwned) {
        deleteCacheOwnedFile(chip.localUri);
      }
    }
    commitAttachments(() => []);
    pathRef.current = Crypto.randomUUID();
    messageUuidRef.current = Crypto.randomUUID();
  }, [cancelUpload, commitAttachments]);

  const uploadPending = useCallback(async (): Promise<UploadPendingResult> => {
    const chips = attachmentsRef.current;
    // A terminal chip blocks the send.
    if (chips.some(chip => chip.status === 'error' && chip.terminal === true)) {
      return { ok: false };
    }
    // An in-flight upload (e.g. a retry) blocks too: its outcome is unknown.
    if (chips.some(chip => chip.status === 'uploading')) {
      return { ok: false };
    }
    const toUpload = chips.filter(
      chip => chip.status === 'pending' || (chip.status === 'error' && chip.terminal !== true)
    );
    // eslint-disable-next-line typescript-eslint/promise-function-async -- map callback returns startUpload's promise directly
    const results = await Promise.all(toUpload.map(chip => startUpload(chip, pathRef.current)));
    if (results.some(result => result.failed)) {
      return { ok: false };
    }

    // Build the uploaded set in chip order from the locally collected results
    // plus already-uploaded chips (e.g. a prior retry), NOT from React state.
    const resultById = new Map(
      results
        .filter((r): r is Extract<UploadRunResult, { failed: false }> => !r.failed)
        .map(r => [r.id, r])
    );
    const uploaded: AgentAttachment[] = [];
    for (const chip of chips) {
      if (
        chip.status === 'uploaded' &&
        chip.remoteFilename !== undefined &&
        chip.remoteKey !== undefined
      ) {
        uploaded.push(chip);
      } else {
        const result = resultById.get(chip.id);
        if (result) {
          uploaded.push({
            ...chip,
            status: 'uploaded',
            remoteFilename: result.remoteFilename,
            remoteKey: result.remoteKey,
            progress: 1,
          });
        }
      }
    }

    const wire = buildWirePayload(uploaded, pathRef.current);
    const submission = buildSubmissionPayload(uploaded, pathRef.current, messageUuidRef.current);
    return { ok: true, wire, submission };
  }, [startUpload]);

  const isUploading = isAnyAttachmentUploading(attachments);
  const hasFailedAttachments = hasAnyFailedAttachment(attachments);

  return useMemo(
    () => ({
      attachments,
      addCandidates,
      removeAttachment,
      retryAttachment,
      reset,
      isUploading,
      hasFailedAttachments,
      uploadPending,
    }),
    [
      attachments,
      addCandidates,
      removeAttachment,
      retryAttachment,
      reset,
      isUploading,
      hasFailedAttachments,
      uploadPending,
    ]
  );
}
