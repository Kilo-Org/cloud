'use client';
import React from 'react';

import { MessagePrimitive } from '@assistant-ui/react';
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
import { AgentWorkGroup } from './AgentWorkGroup';

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
          <AgentWorkGroup key={index} summary={segment.summary}>
            {projectedIndices.map(partIndex => (
              <CloudMessagePartByIndex key={partIndex} index={partIndex} />
            ))}
          </AgentWorkGroup>
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
