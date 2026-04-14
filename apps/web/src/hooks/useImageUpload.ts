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

export type ImageFile = {
  id: string;
  file: File;
  previewUrl: string;
  status: 'processing' | 'pending' | 'uploading' | 'complete' | 'error';
  progress: number;
  r2Key?: string;
  error?: string;
};

export type UploadUrlResult = {
  signedUrl: string;
  key: string;
  expiresAt: string;
};

type ImageAllowedType = (typeof APP_BUILDER_IMAGE_ALLOWED_TYPES)[number];

type ImageResizeOptions = {
  maxDimensionPx: number;
  quality?: number;
};

type ResizeDimensions = {
  width: number;
  height: number;
};

export function isAllowedImageType(
  contentType: string,
  allowedTypes: readonly string[] = APP_BUILDER_IMAGE_ALLOWED_TYPES
): contentType is ImageAllowedType {
  return allowedTypes.some(allowedType => allowedType === contentType);
}

export function calculateResizeDimensions(
  width: number,
  height: number,
  maxDimensionPx: number
): ResizeDimensions {
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimensionPx) {
    return { width, height };
  }

  const scale = maxDimensionPx / longestSide;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

export function validateImageFileSize(
  file: File,
  maxSizeBytes: number,
  label = 'File'
): string | null {
  if (file.size > maxSizeBytes) {
    return `${label} too large: ${formatFileSize(file.size)}. Maximum: ${formatFileSize(maxSizeBytes)}`;
  }
  return null;
}

export function buildImageUploadPath(messageUuid: string): string {
  return messageUuid;
}

type UploadUrlInput = {
  messageUuid: string;
  imageId: string;
  contentType: ImageAllowedType;
  contentLength: number;
};

type OrgUploadUrlInput = UploadUrlInput & { organizationId: string };

export type UseImageUploadOptions = {
  messageUuid: string;
  organizationId?: string;
  maxImages?: number;
  maxOriginalFileSizeBytes?: number;
  maxFileSizeBytes?: number;
  allowedTypes?: readonly string[];
  resizeImages?: ImageResizeOptions;
  onImagesChange?: (images: ImageFile[]) => void;
  /** Override the default app-builder upload mutations. */
  getUploadUrl?: {
    personal: (input: UploadUrlInput) => Promise<UploadUrlResult>;
    organization: (input: OrgUploadUrlInput) => Promise<UploadUrlResult>;
  };
};

export type UseImageUploadReturn = {
  images: ImageFile[];
  addFiles: (files: FileList | File[]) => void;
  removeImage: (imageId: string) => void;
  clearImages: () => void;
  hasUploadingImages: boolean;
  getImagesData: () => Images | undefined;

  isDragging: boolean;
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
};

const activeUploads = new Map<string, XMLHttpRequest>();
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
      const parts = img.r2Key.split('/');
      return parts[parts.length - 1];
    });
}

function validateImageFileType(file: File, allowedTypes: readonly string[]): string | null {
  if (!isAllowedImageType(file.type, allowedTypes)) {
    return `Invalid file type: ${file.type}. Allowed: ${allowedTypes.join(', ')}`;
  }
  return null;
}

async function blobFromCanvas(
  canvas: HTMLCanvasElement,
  contentType: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error('Could not resize image'));
      },
      contentType,
      quality
    );
  });
}

async function resizeImageFile(file: File, resizeImages?: ImageResizeOptions): Promise<File> {
  if (!resizeImages || file.type === 'image/gif') {
    return file;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Could not read image for resizing');
  }

  try {
    const dimensions = calculateResizeDimensions(
      bitmap.width,
      bitmap.height,
      resizeImages.maxDimensionPx
    );
    if (dimensions.width === bitmap.width && dimensions.height === bitmap.height) {
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not resize image');
    }

    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    const blob = await blobFromCanvas(canvas, file.type, resizeImages.quality);
    return new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

async function preprocessImageFile(
  file: File,
  options: {
    allowedTypes: readonly string[];
    maxOriginalFileSizeBytes: number;
    maxFileSizeBytes: number;
    resizeImages?: ImageResizeOptions;
  }
): Promise<File> {
  const typeError = validateImageFileType(file, options.allowedTypes);
  if (typeError) {
    throw new Error(typeError);
  }

  const originalSizeError = validateImageFileSize(
    file,
    options.maxOriginalFileSizeBytes,
    'Original file'
  );
  if (originalSizeError) {
    throw new Error(originalSizeError);
  }

  const resizedFile = await resizeImageFile(file, options.resizeImages);
  const finalSizeError = validateImageFileSize(resizedFile, options.maxFileSizeBytes, 'Final file');
  if (finalSizeError) {
    throw new Error(`${finalSizeError}. Try a smaller image.`);
  }

  return resizedFile;
}

export function useImageUpload(options: UseImageUploadOptions): UseImageUploadReturn {
  const {
    messageUuid,
    organizationId,
    maxImages = APP_BUILDER_IMAGE_MAX_COUNT,
    maxFileSizeBytes = APP_BUILDER_IMAGE_MAX_SIZE_BYTES,
    allowedTypes = APP_BUILDER_IMAGE_ALLOWED_TYPES,
    resizeImages,
    onImagesChange,
    getUploadUrl,
  } = options;
  const maxOriginalFileSizeBytes = options.maxOriginalFileSizeBytes ?? maxFileSizeBytes;

  const [images, setImages] = useState<ImageFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const imagesRef = useRef(images);
  const isMountedRef = useRef(true);
  const cancelledProcessingIdsRef = useRef(new Set<string>());
  imagesRef.current = images;

  const trpc = useTRPC();

  const { mutateAsync: personalMutateAsync } = useMutation(
    trpc.appBuilder.getImageUploadUrl.mutationOptions()
  );
  const { mutateAsync: orgMutateAsync } = useMutation(
    trpc.organizations.appBuilder.getImageUploadUrl.mutationOptions()
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
    onImagesChange?.(images);
  }, [images, onImagesChange]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      imagesRef.current.forEach(img => {
        URL.revokeObjectURL(img.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    const erroredImages = images.filter(img => img.status === 'error');
    if (erroredImages.length === 0) return;

    const timeouts = erroredImages.map(img => {
      return setTimeout(() => {
        URL.revokeObjectURL(img.previewUrl);
        setImages(current => current.filter(i => i.id !== img.id));
      }, 3000);
    });

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [images]);

  const uploadImage = useCallback(
    async (imageFile: ImageFile) => {
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
        updateImage({ status: 'uploading', progress: 0 });

        const contentType = imageFile.file.type;
        if (!isAllowedImageType(contentType, allowedTypes)) {
          throw new Error(`Invalid file type: ${contentType}`);
        }
        const result = await getPresignedUrl({
          messageUuid,
          imageId: imageFile.id,
          contentType,
          contentLength: imageFile.file.size,
        });

        const { signedUrl, key } = result;

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

        updateImage({ status: 'complete', progress: 100, r2Key: key });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Upload failed';

        if (errorMessage !== 'Upload cancelled') {
          toast.error(`Failed to upload image: ${errorMessage}`);
        }

        updateImage({ status: 'error', error: errorMessage });
      } finally {
        uploadingIds.delete(imageFile.id);
      }
    },
    [messageUuid, getPresignedUrl, allowedTypes]
  );

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

      const processingImages = filesToAdd.map(file => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'processing' as const,
        progress: 0,
      }));

      if (processingImages.length === 0) {
        return;
      }

      setImages(current => [...current, ...processingImages]);

      processingImages.forEach((processingImage, index) => {
        const originalFile = filesToAdd[index];
        if (!originalFile) {
          return;
        }

        void preprocessImageFile(originalFile, {
          allowedTypes,
          maxOriginalFileSizeBytes,
          maxFileSizeBytes,
          resizeImages,
        })
          .then(finalFile => {
            if (
              !isMountedRef.current ||
              cancelledProcessingIdsRef.current.has(processingImage.id)
            ) {
              cancelledProcessingIdsRef.current.delete(processingImage.id);
              return;
            }

            const previewUrl = URL.createObjectURL(finalFile);
            URL.revokeObjectURL(processingImage.previewUrl);
            setImages(current =>
              current.map(img =>
                img.id === processingImage.id
                  ? { ...img, file: finalFile, previewUrl, status: 'pending' }
                  : img
              )
            );
          })
          .catch(error => {
            if (
              !isMountedRef.current ||
              cancelledProcessingIdsRef.current.has(processingImage.id)
            ) {
              cancelledProcessingIdsRef.current.delete(processingImage.id);
              return;
            }

            const errorMessage = error instanceof Error ? error.message : 'Could not process image';
            toast.error(errorMessage);
            setImages(current =>
              current.map(img =>
                img.id === processingImage.id
                  ? { ...img, status: 'error', error: errorMessage }
                  : img
              )
            );
          });
      });
    },
    [maxImages, allowedTypes, maxOriginalFileSizeBytes, maxFileSizeBytes, resizeImages]
  );

  const removeImage = useCallback((imageId: string) => {
    const image = imagesRef.current.find(img => img.id === imageId);
    if (!image) return;

    if (image.status === 'processing') {
      cancelledProcessingIdsRef.current.add(imageId);
    }

    const xhr = activeUploads.get(imageId);
    if (xhr) {
      xhr.abort();
      activeUploads.delete(imageId);
    }

    URL.revokeObjectURL(image.previewUrl);
    setImages(current => current.filter(img => img.id !== imageId));
  }, []);

  const clearImages = useCallback(() => {
    imagesRef.current.forEach(img => {
      if (img.status === 'processing') {
        cancelledProcessingIdsRef.current.add(img.id);
      }

      const xhr = activeUploads.get(img.id);
      if (xhr) {
        xhr.abort();
        activeUploads.delete(img.id);
      }
      URL.revokeObjectURL(img.previewUrl);
    });

    setImages([]);
  }, []);

  const hasUploadingImages = images.some(
    img => img.status === 'processing' || img.status === 'uploading' || img.status === 'pending'
  );

  const getImagesData = useCallback((): Images | undefined => {
    const completedFilenames = getCompletedImageFilenames(imagesRef.current);
    if (completedFilenames.length === 0) return undefined;

    return {
      path: buildImageUploadPath(messageUuid),
      files: completedFilenames,
    };
  }, [messageUuid]);

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
