'use client';

import React from 'react';
import { AlertCircle, FileText, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { CloudAgentAttachmentFile } from '@/hooks/useCloudAgentAttachmentUpload';

type AttachmentPreviewStripProps = {
  attachments: CloudAgentAttachmentFile[];
  onRemove: (attachmentId: string) => void;
};

function AttachmentStatus({
  attachment,
  visuallyCompact = false,
}: {
  attachment: CloudAgentAttachmentFile;
  visuallyCompact?: boolean;
}) {
  if (attachment.status === 'error') {
    return (
      <span className="text-destructive flex min-w-0 items-center gap-1 text-xs" role="status">
        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
        <span className={cn(visuallyCompact && 'sr-only')}>
          Upload failed: {attachment.error ?? 'Try again.'}
        </span>
      </span>
    );
  }
  if (attachment.status === 'processing' || attachment.status === 'pending') {
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-xs" role="status">
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        <span className="sr-only">Preparing file</span>
      </span>
    );
  }
  if (attachment.status === 'uploading') {
    return (
      <span
        className={cn('text-muted-foreground text-xs tabular-nums', visuallyCompact && 'sr-only')}
      >
        Uploading {attachment.progress}%
      </span>
    );
  }
  return null;
}

export function AttachmentPreviewStrip({ attachments, onRemove }: AttachmentPreviewStripProps) {
  if (attachments.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2" aria-label="Attached files">
      {attachments.map(attachment =>
        attachment.kind === 'image' && attachment.previewUrl ? (
          <li
            key={attachment.id}
            className={cn(
              'border-border bg-muted/30 relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border',
              attachment.status === 'error' && 'border-destructive'
            )}
          >
            <img
              src={attachment.previewUrl}
              alt={attachment.file.name}
              className={cn(
                'h-full w-full object-cover',
                attachment.status !== 'complete' && 'opacity-50'
              )}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <AttachmentStatus attachment={attachment} visuallyCompact />
              {attachment.status === 'uploading' && (
                <Progress
                  value={attachment.progress}
                  className="absolute inset-x-1 bottom-1 h-1"
                  aria-label={`Uploading ${attachment.file.name}`}
                />
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => onRemove(attachment.id)}
              className="absolute top-1 right-1 h-7 w-7 rounded-md before:absolute before:-inset-2"
              aria-label={`Remove ${attachment.file.name}`}
            >
              <X className="size-3" />
            </Button>
          </li>
        ) : (
          <li
            key={attachment.id}
            className={cn(
              'border-border bg-muted/30 relative flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border p-1',
              attachment.status === 'error' && 'border-destructive'
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  className={cn(
                    'focus-visible:ring-ring flex min-h-0 w-full flex-1 flex-col items-center justify-end gap-1 rounded-md pb-1 focus-visible:ring-2 focus-visible:outline-none',
                    attachment.status !== 'complete' && 'opacity-50'
                  )}
                >
                  <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                  <p className="w-full truncate px-1 text-center text-[10px] leading-tight font-medium">
                    {attachment.file.name}
                  </p>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs break-all text-xs">
                {attachment.file.name}
              </TooltipContent>
            </Tooltip>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <AttachmentStatus attachment={attachment} visuallyCompact />
              {attachment.status === 'uploading' && (
                <Progress
                  value={attachment.progress}
                  className="absolute inset-x-1 bottom-1 h-1"
                  aria-label={`Uploading ${attachment.file.name}`}
                />
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => onRemove(attachment.id)}
              className="absolute top-1 right-1 h-7 w-7 rounded-md before:absolute before:-inset-2"
              aria-label={`Remove ${attachment.file.name}`}
            >
              <X className="size-3" />
            </Button>
          </li>
        )
      )}
    </ul>
  );
}
