import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { trpcClient } from '@/lib/trpc';
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_MAX_FILES,
  AGENT_ATTACHMENT_MIME_BY_EXTENSION,
  type AgentAttachmentExtension,
} from '@/lib/agent-attachments/constants';
import { canAddAttachments, classifyAttachment } from '@/lib/agent-attachments/validate';

export type AgentAttachmentKind = 'image' | 'document';
export type AgentAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

type AllowedContentType = (typeof AGENT_ATTACHMENT_MIME_BY_EXTENSION)[AgentAttachmentExtension];

export type AgentAttachment = {
  id: string;
  filename: string;
  /** Basename of the server-side R2 key; set once the upload succeeds. */
  remoteFilename?: string;
  kind: AgentAttachmentKind;
  mimeType: AllowedContentType;
  size: number;
  localUri: string;
  status: AgentAttachmentStatus;
  error?: string;
};

export type AgentAttachmentCandidate = {
  name: string;
  uri: string;
  mimeType?: string;
  size?: number;
};

export type AgentAttachmentWire = {
  path: string;
  files: string[];
};

type UseAgentAttachmentUploadOptions = {
  organizationId?: string;
};

type UseAgentAttachmentUploadReturn = {
  attachments: AgentAttachment[];
  addCandidates: (candidates: AgentAttachmentCandidate[]) => void;
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  reset: () => void;
  isUploading: boolean;
  hasFailedAttachments: boolean;
  toWirePayload: () => AgentAttachmentWire | undefined;
};

function ensureExtension(name: string, fallback: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    return name;
  }
  return `${name}.${fallback}`;
}

async function uploadOne(args: {
  organizationId?: string;
  attachmentId: string;
  path: string;
  contentType: AllowedContentType;
  localUri: string;
}): Promise<{ key: string }> {
  const { organizationId, attachmentId, path, contentType, localUri } = args;
  // expo-file-system's `File` is not a `Blob`; materialize a real `Blob` from
  // the file:// URI so the PUT body matches the signed Content-Length.
  const localFileResponse = await fetch(localUri);
  const blob = await localFileResponse.blob();
  if (blob.size > AGENT_ATTACHMENT_MAX_BYTES) {
    throw new Error('File is larger than 5 MB');
  }
  const baseInput = {
    messageUuid: path,
    attachmentId,
    contentType,
    contentLength: blob.size,
  };
  const result = organizationId
    ? await trpcClient.organizations.cloudAgentNext.getAttachmentUploadUrl.mutate({
        ...baseInput,
        organizationId,
      })
    : await trpcClient.cloudAgentNext.getAttachmentUploadUrl.mutate(baseInput);
  const response = await fetch(result.signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }
  return { key: result.key };
}

export function useAgentAttachmentUpload(
  options: UseAgentAttachmentUploadOptions = {}
): UseAgentAttachmentUploadReturn {
  const { organizationId } = options;
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const pathRef = useRef<string>(Crypto.randomUUID());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const startUpload = useCallback(
    (attachment: AgentAttachment, path: string) => {
      const update = (patch: Partial<AgentAttachment>) => {
        if (!isMountedRef.current) {
          return;
        }
        setAttachments(current =>
          current.map(item => (item.id === attachment.id ? { ...item, ...patch } : item))
        );
      };

      const run = async () => {
        update({ status: 'uploading', error: undefined });
        try {
          const { key } = await uploadOne({
            organizationId,
            attachmentId: attachment.id,
            path,
            contentType: attachment.mimeType,
            localUri: attachment.localUri,
          });
          // The wire payload must reference the object the server actually
          // stored, so take the filename from the returned R2 key.
          update({ status: 'uploaded', remoteFilename: key.split('/').at(-1) });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upload failed';
          toast.error(`Failed to upload file: ${message}`);
          update({ status: 'error', error: message });
        }
      };

      void run();
    },
    [organizationId]
  );

  const addCandidates = useCallback(
    (candidates: AgentAttachmentCandidate[]) => {
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

      const additions: AgentAttachment[] = [];
      for (const candidate of accepted) {
        const classified = classifyAttachment({
          name: candidate.name,
          mimeType: candidate.mimeType,
          size: candidate.size,
        });
        if (!classified.ok) {
          toast.error(
            classified.reason === 'too-large'
              ? `File too large: ${candidate.name}. Max size is 5 MB.`
              : `File type not supported: ${candidate.name}. Attach PNG, JPEG, WebP, GIF, PDF, TXT, MD, or CSV files.`
          );
        } else {
          const ext = classified.extension;
          additions.push({
            id: Crypto.randomUUID(),
            filename: ensureExtension(candidate.name, ext),
            kind: classified.kind,
            // Always derive the content type from the extension: OS pickers
            // report generic types (e.g. application/octet-stream) that the
            // backend's allowed-type enum rejects.
            mimeType: AGENT_ATTACHMENT_MIME_BY_EXTENSION[ext],
            size: candidate.size ?? 0,
            localUri: candidate.uri,
            status: 'pending',
          });
        }
      }
      if (additions.length === 0) {
        return;
      }
      for (const addition of additions) {
        startUpload(addition, pathRef.current);
      }
      setAttachments(current => [...current, ...additions]);
    },
    [attachments.length, startUpload]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments(current => current.filter(item => item.id !== id));
  }, []);

  const retryAttachment = useCallback(
    (id: string) => {
      const attachment = attachments.find(item => item.id === id);
      if (!attachment) {
        return;
      }
      startUpload(attachment, pathRef.current);
    },
    [attachments, startUpload]
  );

  const reset = useCallback(() => {
    setAttachments([]);
    pathRef.current = Crypto.randomUUID();
  }, []);

  const toWirePayload = useCallback((): AgentAttachmentWire | undefined => {
    const files = attachments
      .filter(item => item.status === 'uploaded')
      .map(item => item.remoteFilename)
      .filter((filename): filename is string => filename !== undefined);
    if (files.length === 0) {
      return undefined;
    }
    return { path: pathRef.current, files };
  }, [attachments]);

  const isUploading = attachments.some(
    item => item.status === 'pending' || item.status === 'uploading'
  );
  const failedAttachments = attachments.some(item => item.status === 'error');

  return useMemo(
    () => ({
      attachments,
      addCandidates,
      removeAttachment,
      retryAttachment,
      reset,
      isUploading,
      hasFailedAttachments: failedAttachments,
      toWirePayload,
    }),
    [
      attachments,
      addCandidates,
      removeAttachment,
      retryAttachment,
      reset,
      isUploading,
      failedAttachments,
      toWirePayload,
    ]
  );
}
