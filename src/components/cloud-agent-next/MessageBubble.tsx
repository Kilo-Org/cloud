'use client';

import { User, Bot, Scissors, Image, FileText } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { StoredMessage, Part, CompactionPart } from './types';
import {
  isUserMessage,
  isAssistantMessage,
  isMessageStreaming,
  isTextPart,
  isCompactionPart,
  isFilePart,
} from './types';
import type { FilePart } from './types';
import { PartRenderer } from './PartRenderer';

/**
 * Compaction separator component - shown when context is compacted
 */
function CompactionSeparator({
  compactionPart,
  timeAgo,
}: {
  compactionPart: CompactionPart;
  timeAgo: string;
}) {
  const isAuto = compactionPart.auto;

  return (
    <div className="flex items-center gap-3 py-4">
      <div className="bg-border h-px flex-1" />
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Scissors className="h-3 w-3" />
        <span>Context compacted{isAuto ? ' (auto)' : ''}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground/60">{timeAgo}</span>
      </div>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

/**
 * Inline file attachment display for user message bubbles
 * Shows icon, filename, and MIME type in a compact format
 */
function InlineFileAttachment({ part }: { part: FilePart }) {
  const isImage = part.mime.startsWith('image/');
  const Icon = isImage ? Image : FileText;
  const displayName = part.filename || (isImage ? 'Image' : 'File');

  // Format MIME type for display (e.g., "image/png" -> "PNG", "application/pdf" -> "PDF")
  const formatMimeType = (mime: string): string => {
    const parts = mime.split('/');
    const subtype = parts[1] || mime;
    // Handle common subtypes
    if (subtype.startsWith('x-')) return subtype.slice(2).toUpperCase();
    if (subtype === 'jpeg') return 'JPEG';
    if (subtype === 'png') return 'PNG';
    if (subtype === 'gif') return 'GIF';
    if (subtype === 'webp') return 'WebP';
    if (subtype === 'pdf') return 'PDF';
    if (subtype === 'plain') return 'TXT';
    return subtype.toUpperCase();
  };

  return (
    <div className="bg-primary-foreground/10 mt-2 flex items-center gap-2 rounded px-2 py-1.5">
      <Icon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate text-sm">{displayName}</span>
      <span className="text-primary-foreground/60 shrink-0 text-xs">
        {formatMimeType(part.mime)}
      </span>
    </div>
  );
}

/**
 * Get user content by combining all text parts
 */
function getUserTextContent(parts: Part[]): string {
  const textParts = parts.filter(isTextPart);
  return textParts.map(p => p.text).join('');
}

type MessageBubbleProps = {
  message: StoredMessage;
  isStreaming?: boolean;
  userName?: string;
  userAvatarUrl?: string;
  /** Function to get messages for a child session ID */
  getChildMessages?: (sessionId: string) => StoredMessage[];
};

const isDev = process.env.NODE_ENV === 'development';

/**
 * Avatar wrapper that shows debug info on hover in dev mode
 */
function AvatarWithDebugInfo({
  children,
  messageId,
  sessionId,
}: {
  children: React.ReactNode;
  messageId: string;
  sessionId: string;
}) {
  if (!isDev) return <>{children}</>;

  return (
    <div className="group relative">
      {children}
      <div className="bg-popover text-popover-foreground pointer-events-none absolute top-full right-0 z-50 mt-1 hidden rounded border px-2 py-1 font-mono text-[10px] whitespace-nowrap shadow-md group-hover:block">
        msg:{messageId}
        <br />
        sess:{sessionId}
      </div>
    </div>
  );
}

/**
 * MessageBubble - Renders V2 StoredMessage format messages.
 *
 * For legacy V1 format messages (historical CLI sessions), use LegacyMessageBubble
 * from @/app/admin/components/LegacyMessageBubble instead.
 */
export function MessageBubble({
  message,
  isStreaming: isStreamingProp,
  userName,
  userAvatarUrl,
  getChildMessages,
}: MessageBubbleProps) {
  const isStreaming = isStreamingProp ?? isMessageStreaming(message);
  const timestamp = message.info.time.created;
  const timeAgo = formatDistanceToNow(new Date(timestamp), { addSuffix: true });

  // User message
  if (isUserMessage(message.info)) {
    // Check if this is a compaction trigger message
    const compactionPart = message.parts.find(isCompactionPart);
    const hasOnlyCompactionParts =
      message.parts.length > 0 && message.parts.every(isCompactionPart);

    // Render compaction separator for compaction-only messages
    if (hasOnlyCompactionParts && compactionPart) {
      return <CompactionSeparator compactionPart={compactionPart} timeAgo={timeAgo} />;
    }

    const displayName = userName ?? 'You';
    const userContent = getUserTextContent(message.parts);
    // Get file parts to render inside the bubble
    const fileParts = message.parts.filter(isFilePart);

    return (
      <div className="flex items-start justify-end gap-2 py-4 md:gap-3">
        <div className="flex flex-1 flex-col items-end space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">{timeAgo}</span>
            <span className="text-sm font-medium">{displayName}</span>
          </div>
          <div className="bg-primary text-primary-foreground max-w-[95%] rounded-lg p-3 sm:max-w-[85%] md:max-w-[80%] md:p-4">
            {userContent && (
              <p className="overflow-wrap-anywhere text-sm wrap-break-word whitespace-pre-wrap">
                {userContent}
              </p>
            )}
            {/* Render file attachments inside the bubble */}
            {fileParts.map((part, index) => (
              <InlineFileAttachment key={part.id || index} part={part} />
            ))}
          </div>
        </div>
        <AvatarWithDebugInfo messageId={message.info.id} sessionId={message.info.sessionID}>
          {userAvatarUrl ? (
            <img
              src={userAvatarUrl}
              alt={displayName}
              className="h-7 w-7 shrink-0 rounded-full object-cover md:h-8 md:w-8"
            />
          ) : (
            <div className="bg-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8">
              <User className="h-4 w-4 text-white" />
            </div>
          )}
        </AvatarWithDebugInfo>
      </div>
    );
  }

  // Assistant message
  if (isAssistantMessage(message.info)) {
    const { cost, tokens } = message.info;

    return (
      <div className="flex items-start gap-2 py-4 md:gap-3">
        <AvatarWithDebugInfo messageId={message.info.id} sessionId={message.info.sessionID}>
          <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8">
            <Bot className="h-4 w-4" />
          </div>
        </AvatarWithDebugInfo>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Kilo Code</span>
            <span className="text-muted-foreground text-xs">{timeAgo}</span>
            {isStreaming && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                  <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
                </span>
                Streaming...
              </span>
            )}
            {/* Cost/token display */}
            {!isStreaming && (cost !== undefined || tokens !== undefined) && (
              <span className="text-muted-foreground text-xs">
                {tokens !== undefined &&
                  `${(tokens.input + tokens.output).toLocaleString()} tokens`}
                {tokens !== undefined && cost !== undefined && ' · '}
                {cost !== undefined && `$${cost.toFixed(4)}`}
              </span>
            )}
          </div>
          {/* Render all parts via PartRenderer */}
          <div className="space-y-2">
            {message.parts.map((part, index) => (
              <PartRenderer
                key={part.id || index}
                part={part}
                isStreaming={isStreaming}
                getChildMessages={getChildMessages}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Fallback (shouldn't happen, but handle gracefully)
  return null;
}
