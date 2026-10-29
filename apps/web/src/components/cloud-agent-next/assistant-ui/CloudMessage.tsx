'use client';
import React from 'react';

import { AlertCircle } from 'lucide-react';
import { MessagePrimitive } from '@assistant-ui/react';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  TextWithLinks,
  CompactionSeparator,
  InlineImageAttachmentCount,
  InlineFileAttachment,
  getUserTextContent,
  getAssistantTextContent,
  DeliveryStatusIcon,
} from '../message-content';
import { getAssistantErrorMessage, isAssistantInterruptError } from '../message-error';
import { getDeliveryBadge } from '../delivery-badge';
import { isCompactionPart, isFilePart, isTextPart } from '../types';
import { getVisibleAssistantParts } from '../message-presentation';
import { parseWorktreeReviewMessage } from '../worktree-review';
import { WorktreeReviewMessageCard } from '../WorktreeReviewMessageCard';
import { PreparationRow } from '../PreparationRow';
import { CommitCard } from '../CommitCard';
import { MessageErrorBoundary } from '../MessageErrorBoundary';
import { CloudMessageParts } from './CloudMessageParts';
import {
  useCloudMessagePresentation,
  useCloudPresentationActions,
} from './cloud-presentation-context';

export function CloudMessage({ child = false }: { child?: boolean }) {
  const presentation = useCloudMessagePresentation();
  const actions = useCloudPresentationActions();
  const first = presentation.sources[0];
  if (!first) return null;
  const parts = presentation.parts.map(part => part.source);
  const isUser = first.info.role === 'user';
  const text = isUser ? getUserTextContent(parts) : getAssistantTextContent(parts);
  const compaction =
    isUser && parts.length > 0 && parts.every(isCompactionPart)
      ? parts.find(isCompactionPart)
      : undefined;
  const error = first.info.role === 'assistant' ? first.info.error : undefined;
  const showError = !presentation.isStreaming && error != null;
  const interrupted = error != null && isAssistantInterruptError(error);
  const statusClass = interrupted ? 'text-muted-foreground' : 'text-destructive';
  const review = isUser ? parseWorktreeReviewMessage(text) : null;
  const files = parts.filter(isFilePart);
  const imageCount = files.filter(part => part.mime.startsWith('image/')).length;
  const badge = getDeliveryBadge(presentation.deliveryState, { sending: presentation.isSending });
  const hasAssistantContent = getVisibleAssistantParts(parts).length > 0;
  const visible = child || isUser || hasAssistantContent || showError;

  return (
    <MessageErrorBoundary>
      {visible && (
        <MessagePrimitive.Root
          data-message-id={compaction && !child ? undefined : presentation.id}
          data-message-role={first.info.role}
          className={
            child
              ? 'bg-muted/30 rounded-md p-2'
              : compaction
                ? undefined
                : isUser
                  ? 'group/msg flex flex-col items-end py-2'
                  : 'group/msg py-1.5'
          }
        >
          {presentation.messageIds.slice(1).map(id => (
            <span key={id} data-message-id={id} aria-hidden="true" />
          ))}
          {child ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline" className="text-xs">
                  {first.info.role}
                </Badge>
                {presentation.isStreaming && (
                  <span className="text-muted-foreground animate-pulse text-xs">streaming...</span>
                )}
              </div>
              <div className="mt-2 space-y-1">
                <CloudMessageParts />
              </div>
            </>
          ) : compaction ? (
            <CompactionSeparator
              compactionPart={compaction}
              timestamp={presentation.displayTimestamp}
            />
          ) : isUser ? (
            <>
              <div className="bg-primary text-primary-foreground relative max-w-[95%] rounded-md px-3 py-2 sm:max-w-[85%] md:max-w-[80%]">
                {badge && <DeliveryStatusIcon badge={badge} />}
                {review ? (
                  <WorktreeReviewMessageCard review={review} />
                ) : (
                  text && (
                    <p className="overflow-wrap-anywhere text-sm leading-relaxed wrap-break-word whitespace-pre-wrap">
                      <TextWithLinks text={text} />
                    </p>
                  )
                )}
                {imageCount > 0 && <InlineImageAttachmentCount count={imageCount} />}
                {files
                  .filter(part => !part.mime.startsWith('image/'))
                  .map(part => (
                    <InlineFileAttachment key={part.id} part={part} />
                  ))}
              </div>
              <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
                {text && <CopyMessageButton getText={() => text} />}
                <TimeAgo
                  timestamp={presentation.displayTimestamp}
                  className="text-muted-foreground/70 text-xs"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-0.5">
                <CloudMessageParts />
              </div>
              {showError && !interrupted && error && (
                <p className={`${statusClass} text-sm`}>{getAssistantErrorMessage(error)}</p>
              )}
              {showError && (
                <span className={`${statusClass} flex items-center gap-1 text-xs`}>
                  <AlertCircle className="h-3 w-3" />
                  {interrupted ? 'Interrupted' : 'Failed'}
                </span>
              )}
              {getVisibleAssistantParts(parts).some(isTextPart) && (
                <div
                  className={cn(
                    'mt-1 flex items-center gap-2 opacity-0 transition-opacity motion-reduce:transition-none group-focus-within/msg:opacity-100 group-hover/msg:opacity-100',
                    presentation.isStreaming && 'invisible'
                  )}
                >
                  <CopyMessageButton getText={() => text} />
                  <TimeAgo
                    timestamp={presentation.displayTimestamp}
                    className="text-muted-foreground/70 text-xs"
                  />
                </div>
              )}
            </>
          )}
        </MessagePrimitive.Root>
      )}
      {presentation.preparations.map(attempt => (
        <PreparationRow
          key={attempt.id}
          attempt={attempt}
          onOpenDetails={actions.onOpenPreparationDetails ?? (() => {})}
        />
      ))}
      {presentation.commits.map(commit => (
        <CommitCard key={commit.commitHash} commit={commit} />
      ))}
    </MessageErrorBoundary>
  );
}
