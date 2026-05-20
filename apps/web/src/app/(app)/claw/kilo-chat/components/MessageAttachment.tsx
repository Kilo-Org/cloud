'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { File as FileIcon, Download, AlertCircle, ImageOff, X } from 'lucide-react';
import type { AttachmentBlock } from '@kilocode/kilo-chat';
import { useAttachmentUrl } from '@kilocode/kilo-chat-hooks';

import { useKiloChatContext } from './kiloChatContext';
import { formatFileSize } from '../lib/format-file-size';

type MessageAttachmentProps = {
  block: AttachmentBlock;
  conversationId: string;
  isOwn: boolean;
  onRemove?: () => void;
};

type ImageAttachmentRenderStateInput = {
  hasData: boolean;
  isError: boolean;
  isLoading: boolean;
};

type ImageAttachmentRenderState = 'error' | 'loading' | 'ready';

export function getImageAttachmentRenderState({
  hasData,
  isError,
  isLoading,
}: ImageAttachmentRenderStateInput): ImageAttachmentRenderState {
  if (isError) return 'error';
  if (isLoading || !hasData) return 'loading';
  return 'ready';
}

export function MessageAttachment({
  block,
  conversationId,
  isOwn,
  onRemove,
}: MessageAttachmentProps) {
  const { kiloChatClient } = useKiloChatContext();
  const { data, isLoading, isError } = useAttachmentUrl(
    kiloChatClient,
    conversationId,
    block.attachmentId
  );
  const isImage = block.mimeType.startsWith('image/');

  if (isImage) {
    const imageState = getImageAttachmentRenderState({
      hasData: Boolean(data),
      isError,
      isLoading,
    });

    return (
      <div className="relative inline-block max-w-full">
        {imageState === 'error' ? (
          <ImageSlot>
            <ImagePlaceholder filename={block.filename} reason="error" />
          </ImageSlot>
        ) : imageState === 'loading' || !data ? (
          <ImageSlot>
            <div className="bg-muted/40 h-[160px] w-[200px] max-w-full animate-pulse rounded-md" />
          </ImageSlot>
        ) : (
          <ImageAttachment
            url={data.url}
            filename={block.filename}
            size={block.size}
            interactive={!onRemove}
          />
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="bg-background/90 text-foreground border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1"
            aria-label={`Remove ${block.filename}`}
            title="Remove attachment"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={isOwn ? 'self-end' : ''}>
      <FileChip
        url={data?.url}
        filename={block.filename}
        size={block.size}
        loading={isLoading}
        error={isError}
        onRemove={onRemove}
      />
    </div>
  );
}

function ImageSlot({ children }: { children: ReactNode }) {
  return (
    <div className="bg-muted/30 flex min-h-[120px] min-w-[160px] max-w-full items-center justify-center rounded-md">
      {children}
    </div>
  );
}

function ImagePlaceholder({ filename, reason }: { filename: string; reason: 'error' | 'tiny' }) {
  const label = reason === 'error' ? "Couldn't load image" : filename;
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-1 px-2 text-center">
      <ImageOff className="h-6 w-6" />
      <span className="line-clamp-2 break-all text-[11px]">{label}</span>
    </div>
  );
}

function ImageAttachment({
  url,
  filename,
  size: _size,
  interactive,
}: {
  url: string;
  filename: string;
  size: number;
  interactive: boolean;
}) {
  const [errored, setErrored] = useState(false);
  // Signed URLs are refreshed periodically by useAttachmentUrl; reset the
  // error state on each new URL so a transient failure doesn't pin the
  // placeholder fallback forever.
  useEffect(() => setErrored(false), [url]);
  if (errored) {
    return (
      <ImageSlot>
        <ImagePlaceholder filename={filename} reason="error" />
      </ImageSlot>
    );
  }
  const img = (
    <img
      src={url}
      alt={filename}
      loading="lazy"
      onError={() => setErrored(true)}
      className={`max-h-[240px] max-w-[320px] rounded-md object-contain ${
        interactive ? 'cursor-zoom-in' : ''
      }`}
    />
  );
  if (!interactive) {
    return <ImageSlot>{img}</ImageSlot>;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
      <ImageSlot>{img}</ImageSlot>
    </a>
  );
}

type FileChipProps = {
  url?: string;
  filename: string;
  size: number;
  loading: boolean;
  error: boolean;
  onRemove?: () => void;
};

function FileChip({ url, filename, size, loading, error, onRemove }: FileChipProps) {
  const content = (
    <>
      <FileIcon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate text-sm">{filename}</span>
      {size > 0 && (
        <span className="text-muted-foreground shrink-0 text-xs">{formatFileSize(size)}</span>
      )}
      <Download className="h-3.5 w-3.5 shrink-0 opacity-70" />
    </>
  );
  const baseClass =
    'inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 max-w-[280px]';
  if (error) {
    return (
      <span className={`${baseClass} text-muted-foreground italic opacity-70`}>
        <AlertCircle className="h-3.5 w-3.5" />
        <span className="text-sm">{filename} (unavailable)</span>
      </span>
    );
  }
  if (loading || !url) {
    return <span className={`${baseClass} opacity-50`}>{content}</span>;
  }
  return (
    <span className="relative inline-flex">
      <a href={url} download className={`${baseClass} hover:bg-muted/40 cursor-pointer`}>
        {content}
      </a>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="bg-background/90 text-foreground border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring absolute -right-2 -top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1"
          aria-label={`Remove ${filename}`}
          title="Remove attachment"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
