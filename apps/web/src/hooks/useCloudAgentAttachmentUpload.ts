'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import {
  CLOUD_AGENT_ATTACHMENT_ALLOWED_TYPES,
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX,
  CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
  type CloudAgentAttachmentAllowedType,
  type CloudAgentAttachments,
} from '@/lib/cloud-agent/constants';
import {
  preprocessImageFile,
  validateImageFileSize,
  type ImageResizeOptions,
  type UploadUrlResult,
} from './useImageUpload';

export type CloudAgentAttachmentFile = {
  id: string;
  file: File;
  contentType: CloudAgentAttachmentAllowedType;
  kind: 'image' | 'document';
  previewUrl?: string;
  status: 'processing' | 'pending' | 'uploading' | 'complete' | 'error';
  progress: number;
  r2Key?: string;
  error?: string;
};

type UploadUrlInput = {
  messageUuid: string;
  attachmentId: string;
  contentType: CloudAgentAttachmentAllowedType;
  contentLength: number;
};

type OrgUploadUrlInput = UploadUrlInput & { organizationId: string };

type ImagePreprocessor = (
  file: File,
  options: {
    allowedTypes: readonly string[];
    maxOriginalFileSizeBytes: number;
    maxFileSizeBytes: number;
    resizeImages?: ImageResizeOptions;
  }
) => Promise<File>;

export type UseCloudAgentAttachmentUploadOptions = {
  messageUuid: string;
  organizationId?: string;
  getUploadUrl?: {
    personal: (input: UploadUrlInput) => Promise<UploadUrlResult>;
    organization: (input: OrgUploadUrlInput) => Promise<UploadUrlResult>;
  };
};

export type UseCloudAgentAttachmentUploadReturn = {
  attachments: CloudAgentAttachmentFile[];
  addFiles: (files: FileList | File[]) => void;
  removeAttachment: (attachmentId: string) => void;
  clearAttachments: () => void;
  hasUploadingAttachments: boolean;
  getAttachmentsData: () => CloudAgentAttachments | undefined;
  isDragging: boolean;
  dragHandlers: {
    onDragEnter: (event: React.DragEvent) => void;
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
};

export function classifyCloudAgentAttachmentType(
  file: File
): CloudAgentAttachmentAllowedType | null {
  if (/\.md$/i.test(file.name)) {
    return !file.type || file.type === 'text/plain' || file.type === 'text/markdown'
      ? 'text/markdown'
      : null;
  }
  if (/\.txt$/i.test(file.name) && (!file.type || file.type === 'text/plain')) return 'text/plain';
  if (/\.csv$/i.test(file.name) && (!file.type || file.type === 'text/csv')) return 'text/csv';
  if (/\.pdf$/i.test(file.name) && (!file.type || file.type === 'application/pdf')) {
    return 'application/pdf';
  }
  if (file.type === 'text/plain' || file.type === 'text/markdown' || file.type === 'text/csv') {
    return null;
  }

  return (
    CLOUD_AGENT_ATTACHMENT_ALLOWED_TYPES.find(contentType => contentType === file.type) ?? null
  );
}

export async function preprocessCloudAgentAttachmentFile(
  file: File,
  processImage: ImagePreprocessor = preprocessImageFile
): Promise<Pick<CloudAgentAttachmentFile, 'file' | 'contentType' | 'kind'>> {
  const contentType = classifyCloudAgentAttachmentType(file);
  if (!contentType) {
    throw new Error(
      `File type not supported: ${file.type || file.name}. Attach PNG, JPEG, WebP, GIF, PDF, TXT, MD, or CSV files.`
    );
  }

  if (contentType.startsWith('image/')) {
    const imageFile = await processImage(file, {
      allowedTypes: CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
      maxOriginalFileSizeBytes: CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
      maxFileSizeBytes: CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
      resizeImages: { maxDimensionPx: CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX },
    });
    return { file: imageFile, contentType, kind: 'image' };
  }

  const sizeError = validateImageFileSize(
    file,
    CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
    'Final file'
  );
  if (sizeError) {
    throw new Error(sizeError);
  }

  return { file, contentType, kind: 'document' };
}

export function selectFilesWithinAttachmentLimit(
  files: File[],
  currentCount: number
): {
  acceptedFiles: File[];
  rejectedCount: number;
} {
  const availableSlots = Math.max(0, CLOUD_AGENT_ATTACHMENT_MAX_COUNT - currentCount);
  const acceptedFiles = files.slice(0, availableSlots);
  return { acceptedFiles, rejectedCount: files.length - acceptedFiles.length };
}

export function shouldContinueCloudAgentAttachmentUpload(
  isMounted: boolean,
  isCancelled: boolean
): boolean {
  return isMounted && !isCancelled;
}

export function shouldCancelCloudAgentAttachmentUpload(
  status: CloudAgentAttachmentFile['status']
): boolean {
  return status === 'processing' || status === 'pending' || status === 'uploading';
}

export function buildCloudAgentAttachments(
  messageUuid: string,
  attachments: CloudAgentAttachmentFile[]
): CloudAgentAttachments | undefined {
  const files = attachments
    .filter(
      (attachment): attachment is CloudAgentAttachmentFile & { r2Key: string } =>
        attachment.status === 'complete' && Boolean(attachment.r2Key)
    )
    .map(attachment => attachment.r2Key.split('/').at(-1))
    .filter((filename): filename is string => filename !== undefined);

  return files.length > 0 ? { path: messageUuid, files } : undefined;
}

export function useCloudAgentAttachmentUpload(
  options: UseCloudAgentAttachmentUploadOptions
): UseCloudAgentAttachmentUploadReturn {
  const { messageUuid, organizationId, getUploadUrl } = options;
  const [attachments, setAttachments] = useState<CloudAgentAttachmentFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const attachmentsRef = useRef(attachments);
  const isMountedRef = useRef(true);
  const cancelledAttachmentIdsRef = useRef(new Set<string>());
  const activeUploadsRef = useRef(new Map<string, XMLHttpRequest>());
  const uploadingIdsRef = useRef(new Set<string>());
  const dragCounterRef = useRef(0);
  attachmentsRef.current = attachments;

  const trpc = useTRPC();
  const { mutateAsync: personalMutateAsync } = useMutation(
    trpc.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgMutateAsync } = useMutation(
    trpc.organizations.cloudAgentNext.getAttachmentUploadUrl.mutationOptions()
  );

  const getPresignedUrl = useCallback(
    async (input: UploadUrlInput): Promise<UploadUrlResult> => {
      if (getUploadUrl) {
        return organizationId
          ? getUploadUrl.organization({ ...input, organizationId })
          : getUploadUrl.personal(input);
      }
      return organizationId
        ? orgMutateAsync({ ...input, organizationId })
        : personalMutateAsync(input);
    },
    [getUploadUrl, organizationId, orgMutateAsync, personalMutateAsync]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      attachmentsRef.current.forEach(attachment => {
        if (shouldCancelCloudAgentAttachmentUpload(attachment.status)) {
          cancelledAttachmentIdsRef.current.add(attachment.id);
        }
        const xhr = activeUploadsRef.current.get(attachment.id);
        if (xhr) {
          xhr.abort();
          activeUploadsRef.current.delete(attachment.id);
        }
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
    };
  }, []);

  const uploadAttachment = useCallback(
    async (attachment: CloudAgentAttachmentFile) => {
      if (uploadingIdsRef.current.has(attachment.id)) return;
      uploadingIdsRef.current.add(attachment.id);
      const canContinue = () =>
        shouldContinueCloudAgentAttachmentUpload(
          isMountedRef.current,
          cancelledAttachmentIdsRef.current.has(attachment.id)
        );
      const updateAttachment = (updates: Partial<CloudAgentAttachmentFile>) => {
        if (!canContinue()) return;
        setAttachments(current =>
          current.map(item => (item.id === attachment.id ? { ...item, ...updates } : item))
        );
      };

      try {
        if (!canContinue()) return;
        updateAttachment({ status: 'uploading', progress: 0 });
        const result = await getPresignedUrl({
          messageUuid,
          attachmentId: attachment.id,
          contentType: attachment.contentType,
          contentLength: attachment.file.size,
        });
        if (!canContinue()) return;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          activeUploadsRef.current.set(attachment.id, xhr);
          xhr.upload.onprogress = event => {
            if (event.lengthComputable) {
              updateAttachment({ progress: Math.round((event.loaded / event.total) * 100) });
            }
          };
          xhr.onload = () => {
            activeUploadsRef.current.delete(attachment.id);
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`Upload failed with status ${xhr.status}`));
          };
          xhr.onerror = () => {
            activeUploadsRef.current.delete(attachment.id);
            reject(new Error('Network error during upload'));
          };
          xhr.onabort = () => {
            activeUploadsRef.current.delete(attachment.id);
            reject(new Error('Upload cancelled'));
          };
          xhr.open('PUT', result.signedUrl);
          xhr.setRequestHeader('Content-Type', attachment.contentType);
          xhr.send(attachment.file);
        });

        updateAttachment({ status: 'complete', progress: 100, r2Key: result.key });
      } catch (error) {
        if (!canContinue()) return;
        const errorMessage = error instanceof Error ? error.message : 'Upload failed';
        if (errorMessage !== 'Upload cancelled') {
          toast.error(`Failed to upload file: ${errorMessage}`);
        }
        updateAttachment({ status: 'error', error: errorMessage });
      } finally {
        uploadingIdsRef.current.delete(attachment.id);
        cancelledAttachmentIdsRef.current.delete(attachment.id);
      }
    },
    [getPresignedUrl, messageUuid]
  );

  useEffect(() => {
    attachments
      .filter(attachment => attachment.status === 'pending')
      .forEach(attachment => {
        void uploadAttachment(attachment);
      });
  }, [attachments, uploadAttachment]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const selected = selectFilesWithinAttachmentLimit(
      Array.from(files),
      attachmentsRef.current.length
    );
    if (selected.acceptedFiles.length === 0 && selected.rejectedCount > 0) {
      toast.error(`Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} files allowed`);
      return;
    }
    if (selected.rejectedCount > 0) {
      toast.warning(
        `Only adding ${selected.acceptedFiles.length} of ${Array.from(files).length} files (max ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT})`
      );
    }

    const processing = selected.acceptedFiles.flatMap(file => {
      const contentType = classifyCloudAgentAttachmentType(file);
      if (!contentType) {
        toast.error(
          `File type not supported: ${file.type || file.name}. Attach PNG, JPEG, WebP, GIF, PDF, TXT, MD, or CSV files.`
        );
        return [];
      }
      const kind = contentType.startsWith('image/') ? ('image' as const) : ('document' as const);
      return [
        {
          id: crypto.randomUUID(),
          file,
          contentType,
          kind,
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
          status: 'processing' as const,
          progress: 0,
        },
      ];
    });
    if (processing.length === 0) return;
    setAttachments(current => [...current, ...processing]);

    processing.forEach(pending => {
      void preprocessCloudAgentAttachmentFile(pending.file)
        .then(processed => {
          if (
            !shouldContinueCloudAgentAttachmentUpload(
              isMountedRef.current,
              cancelledAttachmentIdsRef.current.has(pending.id)
            )
          ) {
            cancelledAttachmentIdsRef.current.delete(pending.id);
            return;
          }
          const previewUrl =
            processed.kind === 'image' ? URL.createObjectURL(processed.file) : undefined;
          if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
          setAttachments(current =>
            current.map(item =>
              item.id === pending.id
                ? { ...item, ...processed, previewUrl, status: 'pending' }
                : item
            )
          );
        })
        .catch(error => {
          if (
            !shouldContinueCloudAgentAttachmentUpload(
              isMountedRef.current,
              cancelledAttachmentIdsRef.current.has(pending.id)
            )
          ) {
            cancelledAttachmentIdsRef.current.delete(pending.id);
            return;
          }
          const errorMessage = error instanceof Error ? error.message : 'Could not process file';
          toast.error(errorMessage);
          setAttachments(current =>
            current.map(item =>
              item.id === pending.id ? { ...item, status: 'error', error: errorMessage } : item
            )
          );
        });
    });
  }, []);

  const removeAttachment = useCallback((attachmentId: string) => {
    const attachment = attachmentsRef.current.find(item => item.id === attachmentId);
    if (!attachment) return;
    if (shouldCancelCloudAgentAttachmentUpload(attachment.status)) {
      cancelledAttachmentIdsRef.current.add(attachmentId);
    }
    const xhr = activeUploadsRef.current.get(attachmentId);
    if (xhr) {
      xhr.abort();
      activeUploadsRef.current.delete(attachmentId);
    }
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments(current => current.filter(item => item.id !== attachmentId));
  }, []);

  const clearAttachments = useCallback(() => {
    attachmentsRef.current.forEach(attachment => {
      if (shouldCancelCloudAgentAttachmentUpload(attachment.status)) {
        cancelledAttachmentIdsRef.current.add(attachment.id);
      }
      const xhr = activeUploadsRef.current.get(attachment.id);
      if (xhr) {
        xhr.abort();
        activeUploadsRef.current.delete(attachment.id);
      }
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    setAttachments([]);
  }, []);

  const getAttachmentsData = useCallback(
    () => buildCloudAgentAttachments(messageUuid, attachmentsRef.current),
    [messageUuid]
  );

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) setIsDragging(true);
  }, []);
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);
      if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
    },
    [addFiles]
  );

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAttachments,
    hasUploadingAttachments: attachments.some(attachment =>
      ['processing', 'pending', 'uploading'].includes(attachment.status)
    ),
    getAttachmentsData,
    isDragging,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
