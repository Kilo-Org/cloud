'use client';
import React from 'react';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MessagePrimitive } from '@assistant-ui/react';
import { cn } from '@/lib/utils';
import type { StoredMessage } from '../types';
import {
  groupAssistantParts,
  groupConsecutiveAssistantMessages,
} from '../shared-transcript-presentation';
import { getVisibleAssistantParts } from '../message-presentation';
import { CloudMessage } from './CloudMessage';
import { CloudMessagePartByIndex } from './CloudMessageParts';
import { CloudReadOnlyThread } from './CloudThread';
import { useCloudMessagePresentation } from './cloud-presentation-context';

function AgentWorkGroup({ indices, summary }: { indices: number[]; summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="hover:bg-muted/40 focus-visible:ring-ring flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="text-muted-foreground min-w-0 flex-1 text-sm">{summary}</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <div className="border-muted space-y-2 border-t px-3 py-2">
          {indices.map(index => (
            <CloudMessagePartByIndex key={index} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}

function SharedMessage() {
  const presentation = useCloudMessagePresentation();
  if (presentation.sources[0]?.info.role === 'user') return <CloudMessage />;
  const parts = presentation.parts.map(part => part.source);
  const indices = new Map(getVisibleAssistantParts(parts).map((part, index) => [part, index]));
  const segments = groupAssistantParts(parts);
  if (segments.length === 0) return null;
  return (
    <MessagePrimitive.Root
      className="space-y-2 py-2"
      data-message-id={presentation.id}
      data-message-role="assistant"
    >
      {presentation.messageIds.slice(1).map(id => (
        <span key={id} data-message-id={id} aria-hidden="true" />
      ))}
      {segments.map((segment, index) => {
        const projectedIndices = segment.parts.flatMap(part => {
          const value = indices.get(part);
          return value === undefined ? [] : [value];
        });
        return segment.type === 'chat' ? (
          <div key={index} className="space-y-2">
            {projectedIndices.map(partIndex => (
              <CloudMessagePartByIndex key={partIndex} index={partIndex} />
            ))}
          </div>
        ) : (
          <AgentWorkGroup key={index} indices={projectedIndices} summary={segment.summary} />
        );
      })}
    </MessagePrimitive.Root>
  );
}

export function CloudSharedTranscript({
  messages,
  unavailable = false,
}: {
  messages: StoredMessage[];
  unavailable?: boolean;
}) {
  if (unavailable)
    return (
      <p className="text-muted-foreground text-sm">
        Couldn&apos;t load this transcript. Refresh the page to try again.
      </p>
    );
  if (messages.length === 0)
    return <p className="text-muted-foreground text-sm">This session has no messages yet.</p>;
  return (
    <CloudReadOnlyThread
      messages={messages}
      messageGroups={groupConsecutiveAssistantMessages(messages)}
      messageComponent={SharedMessage}
    />
  );
}
