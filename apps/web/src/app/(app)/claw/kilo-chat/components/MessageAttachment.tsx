'use client';

import { useState } from 'react';
import { File as FileIcon, Download, AlertCircle } from 'lucide-react';
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
    return (
      <div className="relative mt-1">
        {isLoading || !data ? (
          <div className="bg-muted/40 h-40 w-60 max-w-full animate-pulse rounded-md" />
        ) : (
          <ImageAttachment url={data.url} filename={block.filename} size={block.size} />
        )}
        {isError && (
          <div className="text-destructive mt-1 flex items-center gap-1 text-xs">
            <AlertCircle className="h-3 w-3" />
            <span>Couldn't load image</span>
          </div>
        )}
        {onRemove && (
          <button
            onClick={onRemove}
            className="bg-background/80 hover:bg-background absolute right-1 top-1 rounded-full p-1 text-xs"
            title="Remove attachment"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`mt-1 ${isOwn ? 'self-end' : ''}`}>
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

function ImageAttachment({ url, filename, size }: { url: string; filename: string; size: number }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return <FileChip url={url} filename={filename} size={size} loading={false} error={false} />;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img
        src={url}
        alt={filename}
        loading="lazy"
        onError={() => setErrored(true)}
        className="max-h-[240px] max-w-[320px] cursor-zoom-in rounded-md object-contain"
      />
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
    'inline-flex items-center gap-2 rounded-md border border-current/20 px-2 py-1 max-w-[280px]';
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
      <a href={url} download className={`${baseClass} hover:bg-current/5 cursor-pointer`}>
        {content}
      </a>
      {onRemove && (
        <button
          onClick={onRemove}
          className="bg-background/90 hover:bg-background absolute -right-1 -top-1 rounded-full p-0.5 text-xs leading-none"
          title="Remove attachment"
        >
          ×
        </button>
      )}
    </span>
  );
}
