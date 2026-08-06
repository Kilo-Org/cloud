import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
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

type UseAgentAttachmentUploadOptions = {
  organizationId?: string;
};

type UseAgentAttachmentUploadReturn = {
  attachments: AgentAttachment[];
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  reset: () => void;
  isUploading: boolean;
  hasFailedAttachments: boolean;
  /** Wire payload for the existing `chat-composer` send path. */
  toWirePayload: () => AgentAttachmentWire | undefined;
  /** The S2 submission payload. `undefined` when there are no uploads. */
  toSubmissionPayload: () => AgentAttachmentSubmissionPayload | undefined;
};

export function useAgentAttachmentUpload(
  options: UseAgentAttachmentUploadOptions = {}
): UseAgentAttachmentUploadReturn {
  const { organizationId } = options;
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const pathRef = useRef<string>(Crypto.randomUUID());
  const messageUuidRef = useRef<string>(Crypto.randomUUID());
  const isMountedRef = useRef(true);
  // Row 3.3 stale-outcome guard. `generationRef` bumps on reset so uploads
  // started before a reset can never update state or announce for the new
  // composer session. `liveIdsRef` mirrors the current attachment ids so an
  // in-flight upload for a removed chip is invalidated synchronously — the
  // async completion cannot observe a stale `attachments` closure.
  const generationRef = useRef(0);
  const liveIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const updateAttachment = useCallback((id: string, patch: Partial<AgentAttachment>) => {
    if (!isMountedRef.current) {
      return;
    }
    setAttachments(current => {
      if (!current.some(item => item.id === id)) {
        // Keep the same array reference when the id is gone (removed or
        // reset) so a stale async update cannot replace the attachment list.
        return current;
      }
      return current.map(item => (item.id === id ? { ...item, ...patch } : item));
    });
  }, []);

  const startUpload = useCallback(
    (attachment: AgentAttachment, path: string) => {
      const generation = generationRef.current;
      const run = async () => {
        updateAttachment(attachment.id, {
          status: 'uploading',
          error: undefined,
          terminal: undefined,
          progress: 0,
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
              updateAttachment(attachment.id, { progress });
            },
          });
          // Row 3.3 stale-outcome guard: a removed or reset upload must not
          // flip state or announce for the current composer. Unmount is
          // still suppressed separately via `isMountedRef`.
          if (generationRef.current !== generation || !liveIdsRef.current.has(attachment.id)) {
            return;
          }
          updateAttachment(attachment.id, {
            status: 'uploaded',
            remoteFilename: key.split('/').at(-1),
            progress: 1,
          });
          // Hook-owned success announcement (D19): the flip to terminal
          // success announces exactly once, and only while the composer is
          // still mounted. The chip is presentational and never announces.
          // The call stays isolated so a throwing native announce cannot
          // enter the upload catch and convert success into a failure toast.
          if (isMountedRef.current) {
            try {
              announceForA11y('Attachment uploaded');
            } catch {
              // Best-effort: the uploaded chip is the visible source of truth.
            }
          }
        } catch (error) {
          if (generationRef.current !== generation || !liveIdsRef.current.has(attachment.id)) {
            return;
          }
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
        }
      };
      void run();
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
          const ext = classified.extension;
          const filename = normalizeFilename(candidate.name, ext);
          additions.push({
            id: Crypto.randomUUID(),
            filename,
            kind: classified.kind,
            extension: ext,
            mimeType: mimeForExtension(ext),
            size: classified.size,
            localUri: candidate.uri,
            status: 'pending',
            progress: 0,
          });
        }
      }
      if (additions.length === 0) {
        return;
      }
      setAttachments(current => [...current, ...additions]);
      for (const addition of additions) {
        liveIdsRef.current.add(addition.id);
        startUpload(addition, pathRef.current);
      }
    },
    [attachments.length, startUpload]
  );

  const removeAttachment = useCallback((id: string) => {
    liveIdsRef.current.delete(id);
    setAttachments(current => current.filter(item => item.id !== id));
  }, []);

  const retryAttachment = useCallback(
    (id: string) => {
      const attachment = attachments.find(item => item.id === id);
      if (!attachment || attachment.terminal) {
        // Terminal chips have no retry affordance; bail so a stray
        // tap cannot re-upload a server-rejected file.
        return;
      }
      startUpload(attachment, pathRef.current);
    },
    [attachments, startUpload]
  );

  const reset = useCallback(() => {
    // Invalidate the generation before clearing state so a pending
    // candidate-measurement continuation observes the new generation
    // and drops its candidates instead of adding them post-reset.
    generationRef.current += 1;
    liveIdsRef.current.clear();
    setAttachments([]);
    pathRef.current = Crypto.randomUUID();
    messageUuidRef.current = Crypto.randomUUID();
  }, []);

  const toWirePayload = useCallback(
    (): AgentAttachmentWire | undefined => buildWirePayload(attachments, pathRef.current),
    [attachments]
  );

  const toSubmissionPayload = useCallback(
    (): AgentAttachmentSubmissionPayload | undefined =>
      buildSubmissionPayload(attachments, pathRef.current, messageUuidRef.current),
    [attachments]
  );

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
      toWirePayload,
      toSubmissionPayload,
    }),
    [
      attachments,
      addCandidates,
      removeAttachment,
      retryAttachment,
      reset,
      isUploading,
      hasFailedAttachments,
      toWirePayload,
      toSubmissionPayload,
    ]
  );
}
