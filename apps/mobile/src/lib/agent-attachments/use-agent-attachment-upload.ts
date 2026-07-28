import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';

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
    setAttachments(current => current.map(item => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const startUpload = useCallback(
    (attachment: AgentAttachment, path: string) => {
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
          updateAttachment(attachment.id, {
            status: 'uploaded',
            remoteFilename: key.split('/').at(-1),
            progress: 1,
          });
        } catch (error) {
          const { retryable, reason } = classifyUploadFailure(error);
          updateAttachment(attachment.id, {
            status: 'error',
            error: retryable ? reason : describeTerminalReason(reason),
            terminal: !retryable,
            progress: null,
          });
          // Single toast per failed chip. Terminal surfaces its own chip
          // copy so the toast only needs to echo the same intent.
          toast.error(
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
        startUpload(addition, pathRef.current);
      }
    },
    [attachments.length, startUpload]
  );

  const removeAttachment = useCallback((id: string) => {
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
