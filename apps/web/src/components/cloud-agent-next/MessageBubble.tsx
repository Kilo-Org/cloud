'use client';

import { useCallback } from 'react';
import { Scissors, Image, FileText, AlertCircle, Clock } from 'lucide-react';
import { TimeAgo } from '@/components/shared/TimeAgo';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { MessageDeliveryState } from '@/lib/cloud-agent-sdk';
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
import type { OpenChildSession } from './ChildSessionSection';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { stripImageContext } from '@/lib/app-builder/message-utils';
import { getDeliveryBadge, type DeliveryBadge } from './delivery-badge';

import LinkifyIt from 'linkify-it';

const linkify = new LinkifyIt();

function TextWithLinks({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of linkify.match(text) ?? []) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={match.index}
        href={match.url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline opacity-80 hover:opacity-100"
      >
        {match.text}
      </a>
    );
    lastIndex = match.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

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

function InlineImageAttachmentCount({ count }: { count: number }) {
  return (
    <div className="bg-primary-foreground/10 mt-2 flex items-center gap-2 rounded px-2 py-1.5">
      <Image className="h-4 w-4 shrink-0 opacity-70" />
      <span className="text-sm">
        {count} {count === 1 ? 'image' : 'images'} attached
      </span>
    </div>
  );
}

function InlineFileAttachment({ part }: { part: FilePart }) {
  const displayName = part.filename || 'File';

  const formatMimeType = (mime: string): string => {
    const parts = mime.split('/');
    const subtype = parts[1] || mime;
    if (subtype.startsWith('x-')) return subtype.slice(2).toUpperCase();
    if (subtype === 'pdf') return 'PDF';
    if (subtype === 'plain') return 'TXT';
    return subtype.toUpperCase();
  };

  return (
    <div className="bg-primary-foreground/10 mt-2 flex items-center gap-2 rounded px-2 py-1.5">
      <FileText className="h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate text-sm">{displayName}</span>
      <span className="text-primary-foreground/60 shrink-0 text-xs">
        {formatMimeType(part.mime)}
      </span>
    </div>
  );
}

/**
 * Get user content by combining all text parts.
 * Prefers non-synthetic parts (server-confirmed) over synthetic ones
 * (optimistic placeholders) to avoid duplication when both coexist.
 * Only uses non-synthetic parts if they have non-empty text.
 */
function getUserTextContent(parts: Part[]): string {
  const textParts = parts.filter(isTextPart);
  const nonSynthetic = textParts.filter(p => !p.synthetic && p.text.length > 0);
  const effective = nonSynthetic.length > 0 ? nonSynthetic : textParts;
  return stripImageContext(effective.map(p => p.text).join(''));
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

function DeliveryStatusIcon({ badge }: { badge: DeliveryBadge }) {
  const tooltipLabel = badge.title ? `${badge.label}: ${badge.title}` : badge.label;
  const className =
    badge.tone === 'error'
      ? 'border-destructive/40 text-destructive'
      : 'border-border text-muted-foreground';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={tooltipLabel}
          className={`bg-card ring-background focus-visible:ring-ring focus-visible:ring-offset-background absolute -right-2 -bottom-2 z-10 inline-flex size-6 items-center justify-center rounded-full border ring-2 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${className}`}
          role="img"
          tabIndex={0}
        >
          {badge.tone === 'error' ? (
            <AlertCircle className="size-3.5" />
          ) : (
            <Clock className="size-3.5" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-xs text-xs">
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}

type MessageBubbleProps = {
  message: StoredMessage;
  isStreaming?: boolean;
  /** Delivery state for this message, if any (surfaced via cloud.message.* events). */
  deliveryState?: MessageDeliveryState;
  /** Function to get messages for a child session ID */
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
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
  deliveryState,
  getChildMessages,
  onOpenChildSession,
}: MessageBubbleProps) {
  const isStreaming = isStreamingProp ?? isMessageStreaming(message);
  const timestamp = message.info.time.created;
  const deliveryBadge = getDeliveryBadge(deliveryState);

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
    const imageFileParts = fileParts.filter(part => part.mime.startsWith('image/'));
    const nonImageFileParts = fileParts.filter(part => !part.mime.startsWith('image/'));

    return (
      <div className="group/msg flex flex-col items-end py-2">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover/msg:opacity-100">
            {userContent && <CopyMessageButton getText={getTextForCopy} />}
            <TimeAgo timestamp={timestamp} className="text-muted-foreground/50 text-xs" />
          </div>
        </div>
        <div className="bg-primary text-primary-foreground relative max-w-[95%] rounded-lg p-3 sm:max-w-[85%] md:max-w-[80%] md:p-4">
          {deliveryBadge && <DeliveryStatusIcon badge={deliveryBadge} />}
          {userContent && (
            <p className="overflow-wrap-anywhere text-sm wrap-break-word whitespace-pre-wrap">
              <TextWithLinks text={userContent} />
            </p>
          )}
          {imageFileParts.length > 0 && (
            <InlineImageAttachmentCount count={imageFileParts.length} />
          )}
          {nonImageFileParts.map((part, index) => (
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
              onOpenChildSession={onOpenChildSession}
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
