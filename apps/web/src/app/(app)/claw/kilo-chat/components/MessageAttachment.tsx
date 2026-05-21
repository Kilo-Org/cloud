'use client';

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { File as FileIcon, Download, AlertCircle, ImageOff, X } from 'lucide-react';
import { formatFileSize, type AttachmentBlock } from '@kilocode/kilo-chat';
import { isAttachmentUrlValid, useAttachmentUrl } from '@kilocode/kilo-chat-hooks';

import { useKiloChatContext } from './kiloChatContext';

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
  const isImage = block.mimeType.startsWith('image/');
  const [imageLoaded, setImageLoaded] = useState(false);
  const { data, isLoading, isError, refetch } = useAttachmentUrl(
    kiloChatClient,
    conversationId,
    block.attachmentId,
    { enabled: isImage && !imageLoaded }
  );
  const [downloadPending, setDownloadPending] = useState(false);

  async function loadDownloadUrl() {
    if (data && isAttachmentUrlValid(data.expiresAt, Date.now())) {
      return data.url;
    }
    const result = await refetch();
    if (!result.data) {
      throw new Error('Attachment URL unavailable');
    }
    return result.data.url;
  }

  async function handleFileDownload() {
    setDownloadPending(true);
    try {
      const url = await loadDownloadUrl();
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = block.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      // React Query stores the error state for the chip; no extra toast needed here.
    } finally {
      setDownloadPending(false);
    }
  }

  async function handleImageOpen(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const openedWindow = window.open('about:blank', '_blank');
    if (openedWindow) {
      openedWindow.opener = null;
    }
    try {
      const url = await loadDownloadUrl();
      if (openedWindow) {
        openedWindow.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch {
      openedWindow?.close();
    }
  }

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
            onLoadComplete={() => setImageLoaded(true)}
            onOpen={handleImageOpen}
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
        filename={block.filename}
        size={block.size}
        loading={downloadPending}
        error={isError}
        onDownload={handleFileDownload}
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
  onLoadComplete,
  onOpen,
}: {
  url: string;
  filename: string;
  size: number;
  interactive: boolean;
  onLoadComplete: () => void;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const [errored, setErrored] = useState(false);
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
      onLoad={onLoadComplete}
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
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={onOpen} className="block">
      <ImageSlot>{img}</ImageSlot>
    </a>
  );
}

type FileChipProps = {
  filename: string;
  size: number;
  loading: boolean;
  error: boolean;
  onDownload: () => void;
  onRemove?: () => void;
};

function FileChip({ filename, size, loading, error, onDownload, onRemove }: FileChipProps) {
  const content = (
    <>
      {error ? (
        <>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate text-sm">{filename} (unavailable)</span>
        </>
      ) : (
        <>
          <FileIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate text-sm">{filename}</span>
          {size > 0 && (
            <span className="text-muted-foreground shrink-0 text-xs">{formatFileSize(size)}</span>
          )}
          <Download className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </>
      )}
    </>
  );
  const baseClass =
    'inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 max-w-[280px]';
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onDownload}
        disabled={loading}
        aria-label={`Download ${filename}`}
        className={`${baseClass} hover:bg-muted/40 cursor-pointer disabled:cursor-wait disabled:opacity-50 ${
          error ? 'text-muted-foreground italic opacity-70' : ''
        }`}
      >
        {content}
      </button>
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
