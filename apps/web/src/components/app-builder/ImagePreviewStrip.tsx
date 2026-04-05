'use client';

import { cn } from '@/lib/utils';
import { X, Loader2, AlertCircle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type { ImageFile } from '@/hooks/useImageUpload';

export type ImagePreviewStripProps = {
  images: ImageFile[];
  onRemove: (imageId: string) => void;
  size?: 'default' | 'compact';
};

const sizeConfig = {
  default: {
    container: 'h-20 w-20',
    icon: 'h-5 w-5',
    removeButton: 'h-6 w-6',
    removeIcon: 'h-3.5 w-3.5',
  },
  compact: {
    container: 'h-16 w-16',
    icon: 'h-4 w-4',
    removeButton: 'h-5 w-5',
    removeIcon: 'h-3 w-3',
  },
};

export function ImagePreviewStrip({ images, onRemove, size = 'default' }: ImagePreviewStripProps) {
  const config = sizeConfig[size];

  if (images.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-2 overflow-x-auto">
      {images.map(image => (
        <div
          key={image.id}
          className={cn(
            'group relative block shrink-0 overflow-hidden rounded-lg border',
            config.container,
            image.status === 'error' && 'border-red-500',
            image.status === 'complete' && 'border-zinc-700',
            image.status === 'uploading' && 'border-blue-500',
            image.status === 'pending' && 'border-zinc-700'
          )}
          style={{ position: 'relative' }}
        >
          {/* Preview image */}
          <img
            src={image.previewUrl}
            alt="Upload preview"
            className={cn(
              'h-full w-full object-cover',
              (image.status === 'uploading' || image.status === 'pending') && 'opacity-50'
            )}
          />

          {/* Status overlay */}
          <div className="absolute inset-0 flex items-center justify-center">
            {image.status === 'pending' && (
              <Loader2 className={cn('animate-spin text-zinc-300', config.icon)} />
            )}
            {image.status === 'uploading' && (
              <div className="absolute inset-x-0 bottom-0 p-1">
                <Progress value={image.progress} className="h-1" />
              </div>
            )}
            {image.status === 'error' && (
              <div className="absolute inset-0 flex items-center justify-center bg-red-500/30">
                <AlertCircle className={cn('text-red-400', config.icon)} />
              </div>
            )}
          </div>

          {/* Remove button */}
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onRemove(image.id);
            }}
            className={cn(
              'flex cursor-pointer items-center justify-center rounded-full border border-zinc-600 bg-zinc-800 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:bg-zinc-700',
              config.removeButton,
              image.status === 'error' && 'opacity-100'
            )}
            style={{
              position: 'absolute',
              top: '4px',
              right: '4px',
              zIndex: 10,
            }}
            aria-label="Remove image"
          >
            <X className={config.removeIcon} />
          </button>
        </div>
      ))}
    </div>
  );
}
