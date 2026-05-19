'use client';

import type { QueuedAttachment } from '@kilocode/kilo-chat-hooks';

import { AttachmentPreviewChip } from './AttachmentPreviewChip';

type AttachmentPreviewStripProps = {
  rows: QueuedAttachment[];
  getBlob: (tempId: string) => Blob | null;
  onRemove: (tempId: string) => void;
  onRetry: (tempId: string) => void;
};

export function AttachmentPreviewStrip({
  rows,
  getBlob,
  onRemove,
  onRetry,
}: AttachmentPreviewStripProps) {
  if (rows.length === 0) return null;
  return (
    <div className="border-border flex flex-wrap gap-2 border-b px-4 py-2">
      {rows.map(row => (
        <AttachmentPreviewChip
          key={row.tempId}
          row={row}
          blob={getBlob(row.tempId)}
          onRemove={() => onRemove(row.tempId)}
          onRetry={() => onRetry(row.tempId)}
        />
      ))}
    </div>
  );
}
