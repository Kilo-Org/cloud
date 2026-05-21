'use client';

import { File as FileIcon, RotateCw, X, AlertCircle } from 'lucide-react';
import type { QueuedAttachment } from '@kilocode/kilo-chat-hooks';
import { formatFileSize } from '@kilocode/kilo-chat';

import { useObjectUrl } from '../lib/object-url';

type AttachmentPreviewChipProps = {
  row: QueuedAttachment;
  blob: Blob | null;
  onRemove: () => void;
  onRetry: () => void;
};

export function AttachmentPreviewChip({
  row,
  blob,
  onRemove,
  onRetry,
}: AttachmentPreviewChipProps) {
  const isImage = row.mimeType.startsWith('image/');
  const objectUrl = useObjectUrl(isImage ? blob : null);
  const progressPercent = Math.round(row.progress * 100);

  return (
    <div
      className={`bg-muted/40 relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border ${
        row.status === 'failed' ? 'border-destructive' : 'border-transparent'
      }`}
      title={`${row.filename} · ${formatFileSize(row.size)}${row.error ? ` · ${row.error}` : ''}`}
    >
      {isImage && objectUrl ? (
        <img src={objectUrl} alt={row.filename} className="h-full w-full object-cover" />
      ) : (
        <div className="flex flex-col items-center gap-0.5">
          <FileIcon className="h-5 w-5 opacity-70" />
          <span className="max-w-[60px] truncate text-[10px] opacity-70">{row.filename}</span>
        </div>
      )}

      {row.status === 'uploading' && (
        <div className="bg-background/70 absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-medium">{progressPercent}%</span>
        </div>
      )}

      {row.status === 'failed' && (
        <button
          type="button"
          onClick={onRetry}
          className="bg-background/80 hover:bg-background absolute inset-0 flex items-center justify-center"
          aria-label={`Retry upload for ${row.filename}`}
          title={row.error ? `Retry — ${row.error}` : 'Retry upload'}
        >
          <div className="flex items-center gap-1">
            <AlertCircle className="text-destructive h-3.5 w-3.5" />
            <RotateCw className="h-3.5 w-3.5" />
          </div>
        </button>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="bg-background/90 hover:bg-background absolute right-0.5 top-0.5 rounded-full p-0.5"
        aria-label={`Remove ${row.filename}`}
        title="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
