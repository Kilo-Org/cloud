'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MessageBubble } from '@/components/cloud-agent-next/MessageBubble';
import { PartRenderer } from '@/components/cloud-agent-next/PartRenderer';
import { isAssistantMessage, isUserMessage } from '@/components/cloud-agent-next/types';
import type { Part, StoredMessage } from '@/components/cloud-agent-next/types';
import { cn } from '@/lib/utils';
import { groupAssistantParts } from './shared-transcript';

function AgentWorkGroup({ parts, summary }: { parts: Part[]; summary: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(open => !open)}
        aria-expanded={isExpanded}
        className="hover:bg-muted/40 focus-visible:ring-ring flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="text-muted-foreground min-w-0 flex-1 text-sm">{summary}</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>
      {isExpanded && (
        <div className="border-muted space-y-2 border-t px-3 py-2">
          {parts.map((part, index) => (
            <PartRenderer key={part.id || index} part={part} isStreaming={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function SharedAssistantMessage({ message }: { message: StoredMessage }) {
  const segments = groupAssistantParts(message.parts);
  if (segments.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 py-2">
      {segments.map((segment, index) =>
        segment.type === 'chat' ? (
          <div key={`${message.info.id}-chat-${index}`} className="space-y-2">
            {segment.parts.map((part, partIndex) => (
              <PartRenderer key={part.id || partIndex} part={part} isStreaming={false} />
            ))}
          </div>
        ) : (
          <AgentWorkGroup
            key={`${message.info.id}-work-${index}`}
            parts={segment.parts}
            summary={segment.summary}
          />
        )
      )}
    </div>
  );
}

export function SharedSessionTranscript({ messages }: { messages: StoredMessage[] }) {
  if (messages.length === 0) {
    return <p className="text-muted-foreground text-sm">This session has no messages yet.</p>;
  }

  return (
    <div className="flex flex-col">
      {messages.map(message => {
        if (isUserMessage(message.info)) {
          return <MessageBubble key={message.info.id} message={message} isStreaming={false} />;
        }
        if (isAssistantMessage(message.info)) {
          return <SharedAssistantMessage key={message.info.id} message={message} />;
        }
        return null;
      })}
    </div>
  );
}
