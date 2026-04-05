'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import {
  APP_BUILDER_IMAGE_MAX_COUNT,
  APP_BUILDER_IMAGE_MAX_SIZE_BYTES,
  APP_BUILDER_IMAGE_ALLOWED_TYPES,
} from '@/lib/app-builder/constants';
import type { Images } from '@/lib/images-schema';

// Types
export type ImageFile = {
  id: string;
  file: File;
  previewUrl: string;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  progress: number;
  r2Key?: string;
  error?: string;
};

export type UseImageUploadOptions = {
  messageUuid: string;
  organizationId?: string;
  maxImages?: number;
  onImagesChange?: (images: ImageFile[]) => void;
};

export type UseImageUploadReturn = {
  images: ImageFile[];
  addFiles: (files: FileList | File[]) => void;
  removeImage: (imageId: string) => void;
  clearImages: () => void;
  hasUploadingImages: boolean;
  getImagesData: () => Images | undefined;

  // For drag-and-drop
  isDragging: boolean;
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
};

// Module-level maps to track active XHR requests for cancellation
const activeUploads = new Map<string, XMLHttpRequest>();

// Set to track images that have started uploading (prevents duplicate uploads)
const uploadingIds = new Set<string>();

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getCompletedImageFilenames(images: ImageFile[]): string[] {
  return images
    .filter((img): img is ImageFile & { r2Key: string } => img.status === 'complete' && !!img.r2Key)
    .map(img => {
      // r2Key is like "userId/app-builder/messageUuid/filename.ext" — extract the filename
      const parts = img.r2Key.split('/');
      return parts[parts.length - 1];
    });
}

export function useImageUpload(options: UseImageUploadOptions): UseImageUploadReturn {
  const {
    messageUuid,
    organizationId,
    maxImages = APP_BUILDER_IMAGE_MAX_COUNT,
    onImagesChange,
  } = options;

  const [images, setImages] = useState<ImageFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const trpc = useTRPC();

  // Choose mutation based on context
  const { mutateAsync: personalMutateAsync } = useMutation(
    trpc.appBuilder.getImageUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgMutateAsync } = useMutation(
    trpc.organizations.appBuilder.getImageUploadUrl.mutationOptions()
  );

  // Notify parent of images changes
  useEffect(() => {
    onImagesChange?.(images);
  }, [images, onImagesChange]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      imagesRef.current.forEach(img => {
        URL.revokeObjectURL(img.previewUrl);
      });
    };
  }, []);

  // Auto-remove errored images after 3 seconds
  useEffect(() => {
    const erroredImages = images.filter(img => img.status === 'error');
    if (erroredImages.length === 0) return;

    const timeouts = erroredImages.map(img => {
      return setTimeout(() => {
        setImages(current => current.filter(i => i.id !== img.id));
      }, 3000);
    });

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [images]);

  const validateFile = useCallback((file: File): string | null => {
    if (
      !APP_BUILDER_IMAGE_ALLOWED_TYPES.includes(
        file.type as (typeof APP_BUILDER_IMAGE_ALLOWED_TYPES)[number]
      )
    ) {
      return `Invalid file type: ${file.type}. Allowed: PNG, JPEG, WebP, GIF`;
    }
    if (file.size > APP_BUILDER_IMAGE_MAX_SIZE_BYTES) {
      return `File too large: ${formatFileSize(file.size)}. Maximum: ${formatFileSize(APP_BUILDER_IMAGE_MAX_SIZE_BYTES)}`;
    }
    return null;
  }, []);

  const uploadImage = useCallback(
    async (imageFile: ImageFile) => {
      // Prevent duplicate uploads - check and mark as uploading atomically
      if (uploadingIds.has(imageFile.id)) {
        return;
      }
      uploadingIds.add(imageFile.id);

      const updateImage = (updates: Partial<ImageFile>) => {
        setImages(current =>
          current.map(img => (img.id === imageFile.id ? { ...img, ...updates } : img))
        );
      };

      try {
        // Update status to uploading
        updateImage({ status: 'uploading', progress: 0 });

        // Get presigned URL from backend - use separate calls for type safety
        const baseInput = {
          messageUuid,
          imageId: imageFile.id,
          contentType: imageFile.file.type as (typeof APP_BUILDER_IMAGE_ALLOWED_TYPES)[number],
          contentLength: imageFile.file.size,
        };

        const result = organizationId
          ? await orgMutateAsync({ ...baseInput, organizationId })
          : await personalMutateAsync(baseInput);

        const { signedUrl, key } = result;

        // Upload to R2 using XMLHttpRequest for progress tracking
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          activeUploads.set(imageFile.id, xhr);

          xhr.upload.onprogress = event => {
            if (event.lengthComputable) {
              const progress = Math.round((event.loaded / event.total) * 100);
              updateImage({ progress });
            }
          };

          xhr.onload = () => {
            activeUploads.delete(imageFile.id);
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          };

          xhr.onerror = () => {
            activeUploads.delete(imageFile.id);
            reject(new Error('Network error during upload'));
          };

          xhr.onabort = () => {
            activeUploads.delete(imageFile.id);
            reject(new Error('Upload cancelled'));
          };

          xhr.open('PUT', signedUrl);
          xhr.setRequestHeader('Content-Type', imageFile.file.type);
          xhr.send(imageFile.file);
        });

        // Mark as complete
        updateImage({ status: 'complete', progress: 100, r2Key: key });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Upload failed';

        // Don't show toast for cancelled uploads
        if (errorMessage !== 'Upload cancelled') {
          toast.error(`Failed to upload image: ${errorMessage}`);
        }

        updateImage({ status: 'error', error: errorMessage });
      } finally {
        uploadingIds.delete(imageFile.id);
      }
    },
    [messageUuid, organizationId, orgMutateAsync, personalMutateAsync]
  );

  // Start uploads for pending images
  useEffect(() => {
    const pendingImages = images.filter(img => img.status === 'pending');
    pendingImages.forEach(img => {
      void uploadImage(img);
    });
  }, [images, uploadImage]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const currentCount = imagesRef.current.length;
      const remainingSlots = maxImages - currentCount;

      if (remainingSlots <= 0) {
        toast.error(`Maximum ${maxImages} images allowed`);
        return;
      }

      const filesToAdd = fileArray.slice(0, remainingSlots);
      if (fileArray.length > remainingSlots) {
        toast.warning(
          `Only adding ${remainingSlots} of ${fileArray.length} images (max ${maxImages})`
        );
      }

      const newImages: ImageFile[] = [];
      for (const file of filesToAdd) {
        const validationError = validateFile(file);
        if (validationError) {
          toast.error(validationError);
          continue;
        }

        newImages.push({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'pending',
          progress: 0,
        });
      }

      if (newImages.length > 0) {
        setImages(current => [...current, ...newImages]);
      }
    },
    [maxImages, validateFile]
  );

  const removeImage = useCallback((imageId: string) => {
    const image = imagesRef.current.find(img => img.id === imageId);
    if (!image) return;

    // Cancel in-progress upload if any
    const xhr = activeUploads.get(imageId);
    if (xhr) {
      xhr.abort();
      activeUploads.delete(imageId);
    }

    // Revoke blob URL
    URL.revokeObjectURL(image.previewUrl);

    // Remove from state
    setImages(current => current.filter(img => img.id !== imageId));
  }, []);

  const clearImages = useCallback(() => {
    // Cancel all in-progress uploads
    imagesRef.current.forEach(img => {
      const xhr = activeUploads.get(img.id);
      if (xhr) {
        xhr.abort();
        activeUploads.delete(img.id);
      }
      // Revoke blob URL
      URL.revokeObjectURL(img.previewUrl);
    });

    setImages([]);
  }, []);

  const hasUploadingImages = images.some(
    img => img.status === 'uploading' || img.status === 'pending'
  );

  const getImagesData = useCallback((): Images | undefined => {
    const completedFilenames = getCompletedImageFilenames(imagesRef.current);
    if (completedFilenames.length === 0) return undefined;

    return {
      path: messageUuid,
      files: completedFilenames,
    };
  }, [messageUuid]);

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  return {
    images,
    addFiles,
    removeImage,
    clearImages,
    hasUploadingImages,
    getImagesData,
    isDragging,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
