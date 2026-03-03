'use client';

import { useCallback } from 'react';
import { User, Bot, Info } from 'lucide-react';
import { TimeAgo } from '@/components/shared/TimeAgo';
import type { Message } from './types';
import { MessageContent } from './MessageContent';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';

type MessageBubbleProps = {
  message: Message & {
    say?: string;
    ask?: string;
    metadata?: Record<string, unknown>;
    partial?: boolean;
  };
  isStreaming?: boolean;
  userName?: string;
  userAvatarUrl?: string;
};

export function MessageBubble({
  message,
  isStreaming = false,
  userName,
  userAvatarUrl,
}: MessageBubbleProps) {
  const getTextForCopy = useCallback(() => message.content, [message.content]);

  // User message
  if (message.role === 'user') {
    const displayName = userName ?? 'You';
    return (
      <div className="flex items-start justify-end gap-2 py-4 md:gap-3">
        <div className="flex flex-1 flex-col items-end space-y-1">
          <div className="flex items-center gap-2">
            <TimeAgo timestamp={message.timestamp} className="text-muted-foreground text-xs" />
            <span className="text-sm font-medium">{displayName}</span>
          </div>
          <div className="bg-primary text-primary-foreground max-w-[95%] rounded-lg p-3 sm:max-w-[85%] md:max-w-[80%] md:p-4">
            <p className="overflow-wrap-anywhere text-sm wrap-break-word whitespace-pre-wrap">
              {message.content}
            </p>
          </div>
        </div>
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
      </div>
    );
  }

  // System message (includes tool messages which are type='system' with ask='tool')
  if (message.role === 'system') {
    // Tool messages should render as "Kilo Code" not "System"
    const isToolMessage =
      message.ask === 'tool' || message.ask === 'use_mcp_tool' || message.ask === 'command';

    if (isToolMessage) {
      // Render as Kilo Code with tool card
      return (
        <div className="flex items-start gap-2 py-4 md:gap-3">
          <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Kilo Code</span>
              <TimeAgo timestamp={message.timestamp} className="text-muted-foreground text-xs" />
              {isStreaming && (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <span className="relative flex h-2 w-2">
                    <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                    <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
                  </span>
                  Streaming...
                </span>
              )}
            </div>
            <MessageContent
              content={message.content}
              say={message.say}
              ask={message.ask}
              metadata={message.metadata}
              partial={message.partial}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      );
    }

    // Regular system message
    return (
      <div className="flex items-start gap-2 py-4 md:gap-3">
        <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8">
          <Info className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm font-medium">System</span>
            <TimeAgo timestamp={message.timestamp} className="text-muted-foreground text-xs" />
          </div>
          <div className="text-muted-foreground text-sm">
            <p className="overflow-wrap-anywhere wrap-break-word whitespace-pre-wrap">
              {message.content}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="group/msg flex items-start gap-2 py-4 md:gap-3">
      <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Kilo Code</span>
          <TimeAgo timestamp={message.timestamp} className="text-muted-foreground text-xs" />
          {isStreaming && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <span className="relative flex h-2 w-2">
                <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
              </span>
              Streaming...
            </span>
          )}
          {!isStreaming && (
            <CopyMessageButton
              getText={getTextForCopy}
              className="opacity-0 transition-opacity group-hover/msg:opacity-100"
            />
          )}
        </div>
        <MessageContent
          content={message.content}
          say={message.say}
          ask={message.ask}
          metadata={message.metadata}
          partial={message.partial}
          isStreaming={isStreaming}
        />
      </div>
    </div>
  );
}
