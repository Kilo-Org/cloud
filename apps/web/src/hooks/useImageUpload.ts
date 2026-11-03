'use client';

import { CLOUD_AGENT_IMAGE_ALLOWED_TYPES } from '@/lib/cloud-agent/constants';

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

type ImageAllowedType = (typeof CLOUD_AGENT_IMAGE_ALLOWED_TYPES)[number];

export type ImageResizeOptions = {
  maxDimensionPx: number;
  quality?: number;
};

type ResizeDimensions = {
  width: number;
  height: number;
};

export function isAllowedImageType(
  contentType: string,
  allowedTypes: readonly string[] = CLOUD_AGENT_IMAGE_ALLOWED_TYPES
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

export async function preprocessImageFile(
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
