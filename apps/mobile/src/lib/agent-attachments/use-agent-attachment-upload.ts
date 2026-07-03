import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { trpcClient } from '@/lib/trpc';
import {
  AGENT_ATTACHMENT_MAX_FILES,
  AGENT_ATTACHMENT_MIME_BY_EXTENSION,
} from '@/lib/agent-attachments/constants';
import { canAddAttachments, classifyAttachment } from '@/lib/agent-attachments/validate';

export type AgentAttachmentKind = 'image' | 'document';
export type AgentAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export type AgentAttachment = {
  id: string;
  filename: string;
  storedFilename: string;
  kind: AgentAttachmentKind;
  mimeType: string;
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
  reset: () => void;
  isUploading: boolean;
  toWirePayload: () => AgentAttachmentWire | undefined;
};

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureExtension(name: string, fallback: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    return name;
  }
  return `${name}.${fallback}`;
}

type AllowedContentType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'application/pdf'
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv';

type UploadUrlInput = {
  messageUuid: string;
  attachmentId: string;
  contentType: AllowedContentType;
  contentLength: number;
};

async function uploadOne(args: {
  organizationId?: string;
  attachmentId: string;
  path: string;
  storedFilename: string;
  contentType: AllowedContentType;
  bytes: Uint8Array;
}) {
  const { organizationId, attachmentId, path, storedFilename, contentType, bytes } = args;
  const contentLength = bytes.byteLength;
  const baseInput: UploadUrlInput = {
    messageUuid: path,
    attachmentId,
    contentType,
    contentLength,
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
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }
  return { key: result.key, storedFilename };
}

export function useAgentAttachmentUpload(
  options: UseAgentAttachmentUploadOptions = {}
): UseAgentAttachmentUploadReturn {
  const { organizationId } = options;
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const pathRef = useRef<string>(generateId());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const startUpload = useCallback(
    (attachment: AgentAttachment, path: string) => {
      const setStatus = (status: AgentAttachmentStatus, error?: string) => {
        if (!isMountedRef.current) {
          return;
        }
        setAttachments(current =>
          current.map(item => (item.id === attachment.id ? { ...item, status, error } : item))
        );
      };

      const run = async () => {
        setStatus('uploading');
        try {
          const file = new File(attachment.localUri);
          const bytes = await file.bytes();
          await uploadOne({
            organizationId,
            attachmentId: attachment.id,
            path,
            storedFilename: attachment.storedFilename,
            contentType: attachment.mimeType as AllowedContentType,
            bytes,
          });
          setStatus('uploaded');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upload failed';
          toast.error(`Failed to upload file: ${message}`);
          setStatus('error', message);
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
      setAttachments(current => {
        const limit = canAddAttachments(current.length, candidates.length);
        if (!limit.ok) {
          toast.error(`Maximum ${AGENT_ATTACHMENT_MAX_FILES} files allowed`);
          return current;
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
            const storedFilename = `${generateId()}.${ext}`;
            const mimeType = candidate.mimeType ?? AGENT_ATTACHMENT_MIME_BY_EXTENSION[ext];
            const filename = ensureExtension(candidate.name, ext);
            additions.push({
              id: generateId(),
              filename,
              storedFilename,
              kind: classified.kind,
              mimeType,
              size: candidate.size ?? 0,
              localUri: candidate.uri,
              status: 'pending',
            });
          }
        }
        if (additions.length === 0) {
          return current;
        }
        const path = pathRef.current;
        for (const addition of additions) {
          startUpload(addition, path);
        }
        return [...current, ...additions];
      });
    },
    [startUpload]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments(current => current.filter(item => item.id !== id));
  }, []);

  const reset = useCallback(() => {
    setAttachments([]);
    pathRef.current = generateId();
  }, []);

  const toWirePayload = useCallback((): AgentAttachmentWire | undefined => {
    const uploaded = attachments.filter(item => item.status === 'uploaded');
    if (uploaded.length === 0) {
      return undefined;
    }
    return {
      path: pathRef.current,
      files: uploaded.map(item => item.storedFilename),
    };
  }, [attachments]);

  const isUploading = attachments.some(
    item => item.status === 'pending' || item.status === 'uploading'
  );

  return {
    attachments,
    addCandidates,
    removeAttachment,
    reset,
    isUploading,
    toWirePayload,
  };
}
