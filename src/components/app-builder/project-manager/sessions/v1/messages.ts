/**
 * V1 Messages Module
 *
 * Handles message processing, updates, and stream event mapping for V1 sessions.
 * Works with V1SessionStore instead of the full ProjectStore.
 */

import type { CloudMessage, StreamEvent } from '@/components/cloud-agent/types';
import type { Images } from '@/lib/images-schema';
import type { V1SessionStore } from './store';

/**
 * Time window (in ms) for content-based deduplication.
 * Messages with the same text within this window are considered duplicates.
 * This handles the case where WebSocket returns historical messages in bulk
 * (e.g., on reconnect) - old messages won't match recent optimistic messages.
 */
const DEDUP_TIME_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Updates an existing message or adds a new one.
 * Messages are identified by their timestamp (ts).
 *
 * For user_feedback messages from WebSocket, also performs content-based
 * deduplication to handle the case where an optimistic user message (with client
 * timestamp) is followed by the same message from WebSocket (with server timestamp).
 */
export function updateMessage(store: V1SessionStore, message: CloudMessage): void {
  const prevMessages = store.getState().messages;

  // First: check for exact timestamp match
  const existingIndex = prevMessages.findIndex(m => m.ts === message.ts);

  if (existingIndex !== -1) {
    // Update existing message (e.g., partial → complete)
    const newMessages = [...prevMessages];
    newMessages[existingIndex] = message;
    store.setState({ messages: newMessages });
    return;
  }

  // Content-based deduplication for user_feedback messages only.
  // This handles the case where optimistic user message has client timestamp
  // but WebSocket message has server timestamp. Uses a time window to handle
  // bulk historical messages arriving on WebSocket reconnect.
  if (message.say === 'user_feedback') {
    const isDuplicate = prevMessages.some(
      m =>
        m.type === 'user' &&
        m.text === message.text &&
        Math.abs(m.ts - message.ts) < DEDUP_TIME_WINDOW_MS
    );

    if (isDuplicate) {
      // Skip - keep the existing optimistic message to avoid UI jumping
      return;
    }
  }

  // Add new message
  store.setState({ messages: [...prevMessages, message] });
}

/**
 * Adds a user message to the store.
 */
export function addUserMessage(store: V1SessionStore, content: string, images?: Images): void {
  const userMessage: CloudMessage = {
    ts: Date.now(),
    type: 'user',
    text: content,
    partial: false,
    images,
  };
  updateMessage(store, userMessage);
}

/**
 * Adds an error message to the store.
 */
export function addErrorMessage(store: V1SessionStore, error: string): void {
  const errorMessage: CloudMessage = {
    ts: Date.now(),
    type: 'system',
    say: 'error',
    text: error,
    partial: false,
  };
  updateMessage(store, errorMessage);
}

/**
 * Processes a stream event and updates messages accordingly.
 */
export function processStreamEvent(
  store: V1SessionStore,
  event: StreamEvent & { projectId?: string }
): void {
  switch (event.streamEventType) {
    case 'kilocode': {
      const payload = event.payload as Record<string, unknown>;

      const message: CloudMessage = {
        ts: (payload.timestamp as number) ?? Date.now(),
        type: payload.type === 'say' ? 'assistant' : 'system',
        say: payload.say as string | undefined,
        ask: payload.ask as string | undefined,
        text: (payload.content ?? payload.text) as string | undefined,
        content: (payload.content ?? payload.text) as string | undefined,
        partial: payload.partial as boolean | undefined,
        metadata: payload.metadata as Record<string, unknown> | undefined,
      };

      updateMessage(store, message);
      break;
    }

    case 'status': {
      updateMessage(store, {
        ts: Date.now(),
        type: 'system',
        text: event.message,
        partial: false,
      });
      break;
    }

    case 'output': {
      // Raw output events are not displayed - tools show inline
      break;
    }

    case 'error': {
      addErrorMessage(store, event.error);
      break;
    }

    case 'complete': {
      // Complete events are handled at the streaming level, not message level
      break;
    }

    case 'interrupted': {
      updateMessage(store, {
        ts: Date.now(),
        type: 'system',
        text: event.reason ?? 'Execution interrupted',
        partial: false,
      });
      break;
    }
  }
}
