/**
 * Event Processor
 *
 * Pure TypeScript class that processes events from WebSocket streams.
 * Buffers in-flight (streaming) messages and emits state changes via callbacks.
 *
 * Key behavior:
 * - Messages are stored internally while streaming (for delta accumulation, pending parts)
 * - When a message completes, onMessageCompleted is called and the message is removed
 * - This avoids duplicate storage between processor and consumer (Jotai/store)
 *
 * Storage uses composite keys (sessionId:messageId) for unified handling of
 * both root session and child session messages.
 *
 * This module is framework-agnostic and contains no React/Jotai dependencies.
 */

import type { CloudAgentEvent } from '../event-types';
import { isValidCloudAgentEvent } from '../event-types';
import type { Part } from '@/types/opencode.gen';
import type { ProcessedMessage, EventProcessorConfig } from './types';
import {
  stripPartContentIfFile,
  isUserMessage,
  isAssistantMessage,
  type EventMessageUpdated,
  type EventMessagePartUpdated,
  type EventMessagePartRemoved,
  type EventSessionStatus,
  type EventSessionCreated,
  type EventSessionUpdated,
} from '@/components/cloud-agent-next/types';

/**
 * Event types we handle directly.
 * These are the payload.type values inside kilocode events.
 */
const HANDLED_EVENT_TYPES = new Set([
  'message.updated',
  'message.part.updated',
  'message.part.removed',
  'session.status',
  'session.created',
  'session.updated',
  'session.error',
  'session.idle',
]);

function isHandledEventType(type: string): boolean {
  return HANDLED_EVENT_TYPES.has(type);
}

/**
 * Kilocode event payload structure.
 * Events with streamEventType="kilocode" have this structure in data.
 */
type KilocodePayload = {
  type: string;
  properties: unknown;
};

function isKilocodePayload(data: unknown): data is KilocodePayload {
  return typeof data === 'object' && data !== null && 'type' in data && 'properties' in data;
}

/**
 * Pending part entry - used when parts arrive before their message.
 */
type PendingPartEntry = {
  part: Part;
  delta?: string;
};

/**
 * Check if an assistant message is complete.
 * Complete when time.completed is set (message stopped streaming).
 */
function isAssistantMessageComplete(message: ProcessedMessage): boolean {
  if (!isAssistantMessage(message.info)) return false;
  return message.info.time.completed !== undefined;
}

/**
 * Create composite key for message storage.
 */
function messageKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

export type EventProcessor = {
  /** Process a cloud agent event from WebSocket */
  processEvent: (event: CloudAgentEvent) => void;

  /** Clear all state */
  clear: () => void;
};

/**
 * Create an EventProcessor instance.
 *
 * The processor buffers in-flight (streaming) messages and handles:
 * - Message creation and updates via message.updated events
 * - Part updates with delta support for streaming text
 * - Pending parts queue for parts that arrive before their message
 * - Session parent tracking (sessions with parentID are child sessions)
 * - Session status management (idle/busy/retry)
 *
 * When a message completes (all parts finished, assistant has completed time):
 * - onMessageCompleted callback is fired with the final message
 * - Message is removed from internal storage (consumer stores completed messages)
 */
export function createEventProcessor(config: EventProcessorConfig = {}): EventProcessor {
  const callbacks = config.callbacks ?? {};

  // State - unified storage with composite keys
  // messagesMap: "sessionId:messageId" -> message
  const messagesMap = new Map<string, ProcessedMessage>();
  // pendingParts: "sessionId:messageId" -> pending part entries
  const pendingParts = new Map<string, PendingPartEntry[]>();
  // sessionParents: sessionId -> parentId (null for root session)
  const sessionParents = new Map<string, string | null>();
  // completedMessages: tracks user messages that have been completed (to ignore late updates)
  // Note: user messages don't get completed time and also receive late summaries
  const completedMessages = new Set<string>();

  let streaming = false;

  /**
   * Get parent session ID for a session.
   * Returns null if:
   * - Session was registered as root (parentID: null)
   * - Session was never registered (treat as root)
   */
  function getParentSessionId(sessionId: string): string | null {
    return sessionParents.get(sessionId) ?? null;
  }

  /**
   * Apply pending parts to a message if any exist.
   */
  function applyPendingParts(
    sessionId: string,
    messageId: string,
    message: ProcessedMessage
  ): void {
    const key = messageKey(sessionId, messageId);
    const pending = pendingParts.get(key);
    if (!pending?.length) return;

    const parentSessionId = getParentSessionId(sessionId);
    for (const { part, delta } of pending) {
      applyPartToMessage(message, part, delta);
      callbacks.onPartUpdated?.(sessionId, messageId, part.id, part, parentSessionId);
    }

    pendingParts.delete(key);
  }

  /**
   * Apply a part update to a message, handling delta for streaming text.
   */
  function applyPartToMessage(message: ProcessedMessage, part: Part, delta?: string): void {
    const existingIndex = message.parts.findIndex(p => p.id === part.id);

    if (existingIndex >= 0) {
      const existingPart = message.parts[existingIndex];
      // Apply delta to text parts if provided
      if (delta !== undefined && existingPart.type === 'text' && part.type === 'text') {
        const updatedPart = {
          ...part,
          text: (existingPart.text ?? '') + delta,
        };
        message.parts[existingIndex] = updatedPart;
      } else {
        message.parts[existingIndex] = part;
      }
    } else {
      // New part - if it has delta, that's the initial text
      if (delta !== undefined && part.type === 'text') {
        message.parts.push({ ...part, text: delta });
      } else {
        message.parts.push(part);
      }
    }
  }

  /**
   * Check if an assistant message is complete and handle completion.
   * User messages are completed separately when session goes idle.
   * If complete, fires onMessageCompleted and removes from storage.
   */
  function checkAndHandleCompletion(
    sessionId: string,
    messageId: string,
    message: ProcessedMessage
  ): void {
    // Only check assistant messages here - user messages complete on session idle
    if (isAssistantMessage(message.info) && isAssistantMessageComplete(message)) {
      const key = messageKey(sessionId, messageId);
      const parentSessionId = getParentSessionId(sessionId);
      callbacks.onMessageCompleted?.(sessionId, messageId, message, parentSessionId);
      // Don't add to completedMessages - allow late updates like summaries
      messagesMap.delete(key);
    }
  }

  /**
   * Complete all pending user messages.
   * Called when session goes idle - user messages don't have completion signals,
   * so we mark them complete when the session itself becomes idle.
   */
  function completeUserMessages(): void {
    for (const [key, message] of messagesMap) {
      if (isUserMessage(message.info)) {
        const [sessionId, messageId] = key.split(':');
        const parentSessionId = getParentSessionId(sessionId);
        callbacks.onMessageCompleted?.(sessionId, messageId, message, parentSessionId);
        completedMessages.add(key);
        messagesMap.delete(key);
      }
    }
  }

  /**
   * Handle message.updated events - create or update message info.
   * Ignores updates for messages that have already been completed (e.g., late summary updates).
   */
  function handleMessageUpdated(data: EventMessageUpdated['properties']): void {
    const { info } = data;
    const sessionId = info.sessionID;
    const messageId = info.id;
    const key = messageKey(sessionId, messageId);
    const parentSessionId = getParentSessionId(sessionId);

    // Ignore updates for already-completed messages (e.g., late summary updates)
    if (completedMessages.has(key)) {
      return;
    }

    let message = messagesMap.get(key);
    if (!message) {
      message = { info, parts: [] };
      messagesMap.set(key, message);
    } else {
      message.info = info;
    }

    applyPendingParts(sessionId, messageId, message);
    callbacks.onMessageUpdated?.(sessionId, messageId, message, parentSessionId);
    checkAndHandleCompletion(sessionId, messageId, message);
  }

  /**
   * Handle message.part.updated events - update or queue parts.
   * Ignores updates for messages that have already been completed.
   */
  function handleMessagePartUpdated(data: EventMessagePartUpdated['properties']): void {
    const { delta } = data;
    // Strip large content from file parts immediately to reduce memory
    const part = stripPartContentIfFile(data.part);
    const sessionId = part.sessionID;
    const messageId = part.messageID;
    const key = messageKey(sessionId, messageId);
    const parentSessionId = getParentSessionId(sessionId);

    // Ignore part updates for already-completed messages
    if (completedMessages.has(key)) {
      return;
    }

    const message = messagesMap.get(key);

    if (!message) {
      // Queue for later - message hasn't arrived yet
      const queue = pendingParts.get(key) ?? [];
      queue.push({ part, delta });
      pendingParts.set(key, queue);
      return;
    }

    applyPartToMessage(message, part, delta);
    // Pass the updated part from the message (with delta accumulated), not the raw input
    const updatedPart = message.parts.find(p => p.id === part.id) ?? part;
    callbacks.onPartUpdated?.(sessionId, messageId, part.id, updatedPart, parentSessionId);
    checkAndHandleCompletion(sessionId, messageId, message);
  }

  /**
   * Handle message.part.removed events.
   */
  function handleMessagePartRemoved(data: EventMessagePartRemoved['properties']): void {
    const { sessionID, messageID, partID } = data;
    const key = messageKey(sessionID, messageID);
    const parentSessionId = getParentSessionId(sessionID);

    const message = messagesMap.get(key);
    if (message) {
      message.parts = message.parts.filter(p => p.id !== partID);
      callbacks.onPartRemoved?.(sessionID, messageID, partID, parentSessionId);
    }
  }

  /**
   * Handle session.status events.
   */
  function handleSessionStatus(data: EventSessionStatus['properties']): void {
    const { status } = data;

    callbacks.onSessionStatusChanged?.(status);

    // Update streaming state based on status
    if (status.type === 'idle') {
      // Complete user messages when session becomes idle
      completeUserMessages();

      if (streaming) {
        streaming = false;
        callbacks.onStreamingChanged?.(false);
      }
    } else if (status.type === 'busy') {
      if (!streaming) {
        streaming = true;
        callbacks.onStreamingChanged?.(true);
      }
    }
    // 'retry' status keeps streaming active
  }

  /**
   * Handle session.created events - track session parent relationships.
   */
  function handleSessionCreated(data: EventSessionCreated['properties']): void {
    const { info } = data;

    // Track parent relationship (null for root sessions)
    sessionParents.set(info.id, info.parentID ?? null);

    callbacks.onSessionCreated?.(info);
  }

  /**
   * Handle session.updated events.
   */
  function handleSessionUpdated(data: EventSessionUpdated['properties']): void {
    const { info } = data;
    callbacks.onSessionUpdated?.(info);
  }

  /**
   * Handle session.error events.
   */
  function handleSessionError(data: { sessionID?: string; error?: unknown }): void {
    const errorMessage = typeof data.error === 'string' ? data.error : 'Session error occurred';

    if (streaming) {
      streaming = false;
      callbacks.onStreamingChanged?.(false);
    }

    callbacks.onError?.(errorMessage, data.sessionID);
  }

  /**
   * Handle session.idle events.
   * Completes all pending user messages since they don't have their own completion signals.
   */
  function handleSessionIdle(): void {
    completeUserMessages();

    if (streaming) {
      streaming = false;
      callbacks.onStreamingChanged?.(false);
    }
  }

  /**
   * Process a cloud agent event, dispatching to the appropriate handler.
   */
  function processEvent(event: CloudAgentEvent): void {
    if (!isValidCloudAgentEvent(event)) {
      return;
    }

    let { streamEventType, data } = event;

    // Handle kilocode wrapper: streamEventType="kilocode" with type/properties in data
    if (streamEventType === 'kilocode' && isKilocodePayload(data)) {
      streamEventType = data.type;
      data = data.properties;
    }

    // Skip unknown event types
    if (!isHandledEventType(streamEventType)) {
      return;
    }

    switch (streamEventType) {
      case 'message.updated':
        handleMessageUpdated(data as EventMessageUpdated['properties']);
        break;

      case 'message.part.updated':
        handleMessagePartUpdated(data as EventMessagePartUpdated['properties']);
        break;

      case 'message.part.removed':
        handleMessagePartRemoved(data as EventMessagePartRemoved['properties']);
        break;

      case 'session.status':
        handleSessionStatus(data as EventSessionStatus['properties']);
        break;

      case 'session.created':
        handleSessionCreated(data as EventSessionCreated['properties']);
        break;

      case 'session.updated':
        handleSessionUpdated(data as EventSessionUpdated['properties']);
        break;

      case 'session.error':
        handleSessionError(data as { sessionID?: string; error?: unknown });
        break;

      case 'session.idle':
        handleSessionIdle();
        break;
    }
  }

  /**
   * Clear all state.
   */
  function clear(): void {
    messagesMap.clear();
    pendingParts.clear();
    sessionParents.clear();
    completedMessages.clear();
    streaming = false;
  }

  return {
    processEvent,
    clear,
  };
}
