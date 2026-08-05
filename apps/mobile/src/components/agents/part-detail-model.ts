import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { isPartStreaming, isReasoningPart, isToolPart } from './part-types';
import { getToolDisplay } from './tool-card-display';

/**
 * Resolve a part by id from a surface's live messages. The sheet host calls
 * this on every render so an open sheet tracks the part as it streams.
 */
export function findPartById(messages: readonly StoredMessage[], partId: string): Part | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.id === partId) {
        return part;
      }
    }
  }
  return null;
}

/**
 * Sheet header title for a part. Tools follow the same display projection the
 * fixed row uses so the title updates live with the part. Reasoning shows the
 * stream state; anything else is an unreachable fallback.
 */
export function getPartDetailTitle(part: Part): string {
  if (isReasoningPart(part)) {
    return isPartStreaming(part) ? 'Thinking' : 'Thought';
  }
  if (isToolPart(part)) {
    const display = getToolDisplay(part);
    return display.subtitle ? `${display.title}: ${display.subtitle}` : display.title;
  }
  return 'Details';
}
