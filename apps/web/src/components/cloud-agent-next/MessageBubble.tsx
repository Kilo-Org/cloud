'use client';

import { useCallback } from 'react';
import { Scissors, Image, FileText, AlertCircle } from 'lucide-react';
import { TimeAgo } from '@/components/shared/TimeAgo';
import type { AssistantMessage } from '@/types/opencode.gen';
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
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { stripImageContext } from '@/lib/app-builder/message-utils';

/**
 * Compaction separator component - shown when context is compacted
 */
function CompactionSeparator({
  compactionPart,
  timestamp,
}: {
  compactionPart: CompactionPart;
  timestamp: number | string;
}) {
  const isAuto = compactionPart.auto;

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="bg-border h-px flex-1" />
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Scissors className="h-3 w-3" />
        <span>Context compacted{isAuto ? ' (auto)' : ''}</span>
        <span className="text-muted-foreground/60">·</span>
        <TimeAgo timestamp={timestamp} className="text-muted-foreground/60" />
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
  return stripImageContext(textParts.map(p => p.text).join(''));
}

/**
 * Get copyable text content from message parts.
 * Extracts text from TextParts (the main prose the assistant writes).
 */
function getAssistantTextContent(parts: Part[]): string {
  return parts
    .filter(isTextPart)
    .map(p => p.text)
    .join('\n\n')
    .trim();
}

/**
 * Extract a human-readable error message from an AssistantMessage error field.
 */
function getAssistantErrorMessage(error: NonNullable<AssistantMessage['error']>): string {
  if ('data' in error && 'message' in error.data && typeof error.data.message === 'string') {
    return error.data.message;
  }
  return 'An error occurred while generating a response';
}

type MessageBubbleProps = {
  message: StoredMessage;
  isStreaming?: boolean;
  /** Function to get messages for a child session ID */
  getChildMessages?: (sessionId: string) => StoredMessage[];
};

/**
 * MessageBubble - Renders V2 StoredMessage format messages.
 *
 * For legacy V1 format messages (historical CLI sessions), use LegacyMessageBubble
 * from @/app/admin/components/LegacyMessageBubble instead.
 */
export function MessageBubble({
  message,
  isStreaming: isStreamingProp,
  getChildMessages,
}: MessageBubbleProps) {
  const isStreaming = isStreamingProp ?? isMessageStreaming(message);
  const timestamp = message.info.time.created;

  const getTextForCopy = useCallback(
    () =>
      isUserMessage(message.info)
        ? getUserTextContent(message.parts)
        : getAssistantTextContent(message.parts),
    [message.info, message.parts]
  );

  // User message
  if (isUserMessage(message.info)) {
    // Check if this is a compaction trigger message
    const compactionPart = message.parts.find(isCompactionPart);
    const hasOnlyCompactionParts =
      message.parts.length > 0 && message.parts.every(isCompactionPart);

    // Render compaction separator for compaction-only messages
    if (hasOnlyCompactionParts && compactionPart) {
      return <CompactionSeparator compactionPart={compactionPart} timestamp={timestamp} />;
    }

    const userContent = getUserTextContent(message.parts);
    const fileParts = message.parts.filter(isFilePart);

    return (
      <div className="group/msg flex flex-col items-end py-2">
        <div className="mb-1 flex items-center gap-2 opacity-0 transition-opacity group-hover/msg:opacity-100">
          {userContent && <CopyMessageButton getText={getTextForCopy} />}
          <TimeAgo timestamp={timestamp} className="text-muted-foreground/50 text-xs" />
        </div>
        <div className="bg-primary text-primary-foreground max-w-[95%] rounded-lg p-3 sm:max-w-[85%] md:max-w-[80%] md:p-4">
          {userContent && (
            <p className="overflow-wrap-anywhere text-sm wrap-break-word whitespace-pre-wrap">
              {userContent}
            </p>
          )}
          {fileParts.map((part, index) => (
            <InlineFileAttachment key={part.id || index} part={part} />
          ))}
        </div>
      </div>
    );
  }

  // Assistant message
  if (isAssistantMessage(message.info)) {
    const { error } = message.info;
    const showError = !isStreaming && error !== undefined;
    const errorMessage = error ? getAssistantErrorMessage(error) : undefined;

    return (
      <div className="group/msg py-2">
        <div className="mb-1 flex items-center gap-2 opacity-0 transition-opacity group-hover/msg:opacity-100">
          <TimeAgo timestamp={timestamp} className="text-muted-foreground/50 text-xs" />
          {!isStreaming && message.parts.some(isTextPart) && (
            <CopyMessageButton getText={getTextForCopy} />
          )}
        </div>
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
        {showError && errorMessage && <p className="text-destructive text-sm">{errorMessage}</p>}
        {showError && (
          <span className="text-destructive flex items-center gap-1 text-xs">
            <AlertCircle className="h-3 w-3" />
            Failed
          </span>
        )}
      </div>
    );
  }

  // Fallback (shouldn't happen, but handle gracefully)
  return null;
}
