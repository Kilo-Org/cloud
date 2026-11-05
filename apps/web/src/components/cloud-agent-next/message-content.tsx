'use client';
import React from 'react';
import { Scissors, Image, FileText, AlertCircle, Clock, LoaderCircle } from 'lucide-react';
import LinkifyIt from 'linkify-it';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { stripImageContext } from '@/lib/cloud-agent/message-utils';
import { toSafeHttpUrl } from '@/lib/safe-http-url';
import { isTextPart, type Part, type CompactionPart, type FilePart } from './types';
import type { DeliveryBadge } from './delivery-badge';
const linkify = new LinkifyIt();

export function TextWithLinks({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of linkify.match(text) ?? []) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const safeHref = toSafeHttpUrl(match.url);
    parts.push(
      safeHref ? (
        <a
          key={match.index}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          className="underline opacity-80 hover:opacity-100"
        >
          {match.text}
        </a>
      ) : (
        match.text
      )
    );
    lastIndex = match.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

/**
 * Compaction separator component - shown when context is compacted. It carries
 * the group's first message id because the compactor message is the only thing
 * a compaction-only group renders: the resume link's `?at=` anchor resolves
 * through `[data-message-id]`, and without it the separator would be the one
 * group a recorded position could not land on.
 */
export function CompactionSeparator({
  messageId,
  compactionPart,
  timestamp,
}: {
  messageId?: string;
  compactionPart: CompactionPart;
  timestamp: number | string;
}) {
  const isAuto = compactionPart.auto;

  return (
    <div className="flex items-center gap-3 py-2" data-message-id={messageId}>
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

export function InlineImageAttachmentCount({ count }: { count: number }) {
  return (
    <div className="bg-primary-foreground/10 mt-2 flex items-center gap-2 rounded px-2 py-1.5">
      <Image className="h-4 w-4 shrink-0 opacity-70" />
      <span className="text-sm">
        {count} {count === 1 ? 'image' : 'images'} attached
      </span>
    </div>
  );
}

export function InlineFileAttachment({ part }: { part: FilePart }) {
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
export function getUserTextContent(parts: Part[]): string {
  const textParts = parts.filter(isTextPart);
  const nonSynthetic = textParts.filter(p => !p.synthetic && p.text.length > 0);
  const effective = nonSynthetic.length > 0 ? nonSynthetic : textParts;
  return stripImageContext(effective.map(p => p.text).join(''));
}

/**
 * Get copyable text content from message parts.
 * Extracts text from TextParts (the main prose the assistant writes).
 */
export function getAssistantTextContent(parts: Part[]): string {
  return parts
    .filter(isTextPart)
    .map(p => p.text)
    .join('\n\n')
    .trim();
}

export function DeliveryStatusIcon({ badge }: { badge: DeliveryBadge }) {
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
          {badge.label === 'Failed to deliver' ? (
            <AlertCircle className="size-3.5" />
          ) : badge.spinner ? (
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
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
