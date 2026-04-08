/**
 * Event Processor
 *
 * Pure TypeScript class that processes events from WebSocket streams.
 * Buffers messages while streaming and after completion so late metadata/part
 * updates can still merge into the final message before the consumer renders it.
 *
 * Key behavior:
 * - Messages are stored internally for pending parts and late updates
 * - When a message completes, onMessageCompleted is called and the buffered message is retained
 *
 * Storage uses composite keys (sessionId:messageId) for unified handling of
 * both root session and child session messages.
 *
 * This module is framework-agnostic and contains no React/Jotai dependencies.
 */

import type { CloudAgentEvent } from '../event-types';
import { isValidCloudAgentEvent } from '../event-types';
import type { Part, QuestionInfo } from '@/types/opencode.gen';
import type { ProcessedMessage, EventProcessorConfig, AutocommitStatus } from './types';
import {
  stripPartContentIfFile,
  isUserMessage,
  isAssistantMessage,
  isToolPart,
  isTextPart,
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
  'session.turn.close',
  'question.asked',
  'question.replied',
  'question.rejected',
  'wrapper_disconnected',
  'error',
  'interrupted',
  'autocommit_started',
  'autocommit_completed',
  'complete',
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

  /** Force-complete all in-flight messages. Called on session interrupt. */
  forceCompleteAll: () => void;

  /** Clear all state */
  clear: () => void;
};

/**
 * Create an EventProcessor instance.
 *
 * The processor buffers in-flight (streaming) messages and handles:
 * - Message creation and updates via message.updated events
 * - Part updates (upsert by part id)
 * - Pending parts queue for parts that arrive before their message
 * - Session parent tracking (sessions with parentID are child sessions)
 * - Session status management (idle/busy/retry)
 *
 * When a message completes:
 * - onMessageCompleted callback is fired once for that completion transition
 * - Message remains buffered so later metadata-only and part updates can merge safely
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
  // completedMessages: tracks messages that have already fired onMessageCompleted
  // so completion stays idempotent across repeated idle/complete-style signals.
  const completedMessages = new Set<string>();

  let streaming = false;
  // Set when an interrupted/wrapper_disconnected/error event arrives.
  // Suppresses subsequent session.error events (aftershocks from the CLI dying).
  let terminated = false;

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
   * Check if a session is a child/sub-agent session.
   * A session is a child if it has a non-null parent in sessionParents.
   * Unknown/unregistered sessions are treated as root (safe default).
   */
  function isChildSession(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return getParentSessionId(sessionId) !== null;
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
    for (const { part } of pending) {
      applyPartToMessage(message, part);
      callbacks.onPartUpdated?.(sessionId, messageId, part.id, part, parentSessionId);
    }

    pendingParts.delete(key);
  }

  /**
   * Apply a part update to a message — upsert by part id.
   * Returns false if the update was rejected (no mutation occurred), true otherwise.
   */
  function applyPartToMessage(message: ProcessedMessage, part: Part): boolean {
    const existingIndex = message.parts.findIndex(p => p.id === part.id);

    // For user messages, don't allow an update to clear existing text from a text part.
    if (isUserMessage(message.info) && existingIndex >= 0 && isTextPart(part) && !part.text) {
      const existing = message.parts[existingIndex];
      if (isTextPart(existing) && existing.text) {
        return false;
      }
    }

    if (existingIndex >= 0) {
      message.parts[existingIndex] = part;
    } else {
      message.parts.push(part);
    }
    return true;
  }

  /**
   * Check if an assistant message is complete and handle completion.
   * User messages are completed separately when session goes idle.
   * If complete, fires onMessageCompleted once and keeps the buffered message.
   */
  function checkAndHandleCompletion(
    sessionId: string,
    messageId: string,
    message: ProcessedMessage
  ): void {
    // Only check assistant messages here - user messages complete on session idle
    if (isAssistantMessage(message.info) && isAssistantMessageComplete(message)) {
      const key = messageKey(sessionId, messageId);
      if (completedMessages.has(key)) {
        return;
      }
      const parentSessionId = getParentSessionId(sessionId);
      callbacks.onMessageCompleted?.(sessionId, messageId, message, parentSessionId);
      completedMessages.add(key);
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
        if (completedMessages.has(key)) {
          continue;
        }
        const parentSessionId = getParentSessionId(sessionId);
        callbacks.onMessageCompleted?.(sessionId, messageId, message, parentSessionId);
        completedMessages.add(key);
      }
    }
  }

  /**
   * Handle message.updated events - create or update message info.
   * Completed messages stay buffered so late metadata-only updates do not drop parts.
   */
  function handleMessageUpdated(data: EventMessageUpdated['properties']): void {
    const { info } = data;
    const sessionId = info.sessionID;
    const messageId = info.id;
    const key = messageKey(sessionId, messageId);
    const parentSessionId = getParentSessionId(sessionId);

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
   * Completed messages stay buffered so late part updates can still merge.
   */
  function handleMessagePartUpdated(data: EventMessagePartUpdated['properties']): void {
    // Strip large content from file parts immediately to reduce memory
    const part = stripPartContentIfFile(data.part);
    const sessionId = part.sessionID;
    const messageId = part.messageID;
    const key = messageKey(sessionId, messageId);
    const parentSessionId = getParentSessionId(sessionId);

    const message = messagesMap.get(key);

    if (!message) {
      // Queue for later - message hasn't arrived yet
      const queue = pendingParts.get(key) ?? [];
      queue.push({ part });
      pendingParts.set(key, queue);
      return;
    }

    const applied = applyPartToMessage(message, part);
    if (applied) {
      const updatedPart = message.parts.find(p => p.id === part.id) ?? part;
      callbacks.onPartUpdated?.(sessionId, messageId, part.id, updatedPart, parentSessionId);
      checkAndHandleCompletion(sessionId, messageId, message);
    }
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
   * Child session status events still trigger user message completion
   * but do NOT fire onSessionStatusChanged, onStreamingChanged, or toggle the streaming flag.
   */
  function handleSessionStatus(data: EventSessionStatus['properties']): void {
    const { status, sessionID } = data;
    const fromChild = isChildSession(sessionID);

    if (!fromChild) {
      callbacks.onSessionStatusChanged?.(status);
    }

    // Update streaming state based on status
    if (status.type === 'idle') {
      // Complete user messages when session becomes idle (for both root and child).
      // Streaming is NOT stopped here — the wrapper's `complete` event is the
      // definitive signal (fires after autocommit finishes).
      completeUserMessages();
    } else if (status.type === 'busy') {
      // New execution started — prior termination state is stale
      terminated = false;
      if (!fromChild && !streaming) {
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
   * onError fires for all sessions (root and child).
   * Streaming toggle only fires for root sessions.
   *
   * When `terminated` is true, the session was already interrupted/disconnected
   * and this is just an aftershock from the CLI dying — skip the error banner.
   */
  function handleSessionError(data: { sessionID?: string; error?: unknown }): void {
    if (terminated) return;

    const errorMessage = typeof data.error === 'string' ? data.error : 'Session error occurred';
    const fromChild = isChildSession(data.sessionID);

    if (!fromChild && streaming) {
      streaming = false;
      callbacks.onStreamingChanged?.(false);
    }

    callbacks.onError?.(errorMessage, data.sessionID);
  }

  /**
   * Handle question.asked events.
   * Tool-associated questions map callID→requestId for QuestionToolCard.
   * Standalone questions (no tool) are forwarded separately.
   */
  function handleQuestionAsked(data: {
    id: string;
    questions?: Array<QuestionInfo>;
    tool?: { callID: string };
  }): void {
    const requestId = data.id;
    const callId = data.tool?.callID;
    if (requestId && callId) {
      callbacks.onQuestionAsked?.(requestId, callId);
    } else if (requestId && !callId && data.questions) {
      callbacks.onStandaloneQuestionAsked?.(requestId, data.questions);
    }
  }

  /**
   * Handle session.idle events.
   * Completes all pending user messages since they don't have their own completion signals.
   * Child session idle events still trigger user message completion
   * but do NOT toggle the streaming flag or fire onStreamingChanged.
   */
  function handleSessionIdle(_data: { sessionID: string }): void {
    // Complete user messages for both root and child sessions.
    // Streaming is NOT stopped here — the wrapper's `complete` event handles that.
    completeUserMessages();
  }

  /**
   * Force-complete all in-flight messages.
   * Stamps synthetic time.completed on assistant messages and completes user messages.
   * Sets streaming to false via callback unless skipStreamingToggle is true
   * (used when called for child session events that shouldn't affect root streaming state).
   */
  function forceCompleteAllMessages(skipStreamingToggle = false): void {
    const now = Date.now();
    for (const [key, message] of messagesMap) {
      if (!isAssistantMessage(message.info)) continue;

      const [sessionId, messageId] = key.split(':');
      const parentSessionId = getParentSessionId(sessionId);

      if (!isAssistantMessageComplete(message)) {
        message.info = {
          ...message.info,
          time: { ...message.info.time, completed: now },
        };

        // Force-complete any in-flight tool parts so their spinners stop
        forceCompleteToolParts(message, now);

        callbacks.onMessageCompleted?.(sessionId, messageId, message, parentSessionId);
        completedMessages.add(key);
      } else if (forceCompleteToolParts(message, now)) {
        // Already-completed messages can still have stuck tool parts when the
        // server sent time.completed before all part updates arrived.
        // Notify the UI so it re-renders the cleaned-up parts.
        callbacks.onMessageUpdated?.(sessionId, messageId, message, parentSessionId);
      }
    }

    completeUserMessages();

    if (!skipStreamingToggle && streaming) {
      streaming = false;
      callbacks.onStreamingChanged?.(false);
    }
  }

  /**
   * Force-complete tool parts that are stuck in pending/running state.
   * Transitions them to error state with a synthetic timestamp so the UI
   * stops showing a spinner.
   * Returns true if any parts were modified.
   */
  function forceCompleteToolParts(message: ProcessedMessage, now: number): boolean {
    let modified = false;
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (!isToolPart(part)) continue;
      if (part.state.status === 'completed' || part.state.status === 'error') continue;

      const start = part.state.status === 'running' ? part.state.time.start : now;
      message.parts[i] = {
        ...part,
        state: {
          status: 'error',
          input: part.state.input,
          error: 'Connection lost',
          time: { start, end: now },
        },
      };
      modified = true;
    }
    return modified;
  }

  /**
   * Handle session.turn.close events.
   * When reason is "error", force-complete all in-flight assistant messages
   * that never received time.completed from the server.
   * No ErrorBanner — the session is still alive; the user can retry.
   */
  function handleSessionTurnClose(data: { sessionID?: string; reason?: string }): void {
    if (data.reason !== 'error') {
      return;
    }

    const fromChild = isChildSession(data.sessionID);
    forceCompleteAllMessages(fromChild);
  }

  /**
   * Handle wrapper_disconnected events — the container WebSocket died.
   * Sets inline indicator via handleEvent in the consumer; no ErrorBanner.
   */
  function handleWrapperDisconnected(): void {
    terminated = true;
    forceCompleteAllMessages();
  }

  /**
   * Handle bare "error" events from the reaper or interrupt flow.
   * These are NOT session.error — they come with { error, fatal } payloads.
   * Sets inline indicator via handleEvent in the consumer; no ErrorBanner.
   */
  function handleBareError(data: { fatal?: boolean }): void {
    terminated = true;
    if (data.fatal) {
      forceCompleteAllMessages();
    }
    if (streaming) {
      streaming = false;
      callbacks.onStreamingChanged?.(false);
    }
  }

  /**
   * Handle "interrupted" events — the execution was interrupted.
   * Sets inline indicator via handleEvent in the consumer; no ErrorBanner.
   */
  function handleInterrupted(): void {
    terminated = true;
    forceCompleteAllMessages();
  }

  /**
   * Handle the wrapper's "complete" event — the execution is fully done
   * (including autocommit). This is the definitive "safe to send another message" signal.
   */
  function handleExecutionComplete(data: Record<string, unknown>): void {
    if (streaming) {
      streaming = false;
      callbacks.onStreamingChanged?.(false);
    }
    if (typeof data.currentBranch === 'string' && data.currentBranch) {
      callbacks.onBranchChanged?.(data.currentBranch);
    }
  }

  /**
   * Handle autocommit_started events.
   * Only fires callback if the event includes a messageId.
   */
  function handleAutocommitStarted(data: { message?: string; messageId?: string }): void {
    if (!data.messageId) return;
    const status: AutocommitStatus = {
      status: 'in_progress',
      message: data.message ?? 'Committing changes...',
      timestamp: new Date().toISOString(),
    };
    callbacks.onAutocommitUpdated?.(data.messageId, status);
  }

  /**
   * Handle autocommit_completed events.
   * Only fires callback if the event includes a messageId.
   * Skipped autocommits are silently dropped (no map entry).
   */
  function handleAutocommitCompleted(data: {
    success?: boolean;
    message?: string;
    skipped?: boolean;
    commitHash?: string;
    commitMessage?: string;
    messageId?: string;
  }): void {
    if (!data.messageId) return;
    if (data.skipped) return;
    const status: AutocommitStatus = {
      status: data.success ? 'completed' : 'failed',
      message: data.message ?? (data.success ? 'Changes committed' : 'Commit failed'),
      timestamp: new Date().toISOString(),
      commitHash: data.commitHash,
      commitMessage: data.commitMessage,
    };
    callbacks.onAutocommitUpdated?.(data.messageId, status);
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
        handleSessionIdle(data as { sessionID: string });
        break;

      case 'session.turn.close':
        handleSessionTurnClose(data as { sessionID?: string; reason?: string });
        break;

      case 'question.asked':
        handleQuestionAsked(
          data as {
            id: string;
            questions?: Array<QuestionInfo>;
            tool?: { callID: string };
          }
        );
        break;

      case 'question.replied':
      case 'question.rejected': {
        const requestID = (data as { requestID?: string }).requestID;
        if (requestID) {
          callbacks.onQuestionResolved?.(requestID);
        }
        break;
      }

      case 'wrapper_disconnected':
        handleWrapperDisconnected();
        break;

      case 'error':
        handleBareError(data as { fatal?: boolean });
        break;

      case 'interrupted':
        handleInterrupted();
        break;

      case 'complete':
        handleExecutionComplete((data ?? {}) as Record<string, unknown>);
        break;

      case 'autocommit_started':
        handleAutocommitStarted(data as { message?: string; messageId?: string });
        break;

      case 'autocommit_completed':
        handleAutocommitCompleted(
          data as {
            success?: boolean;
            message?: string;
            skipped?: boolean;
            commitHash?: string;
            commitMessage?: string;
            messageId?: string;
          }
        );
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
    terminated = false;
  }

  return {
    processEvent,
    forceCompleteAll: forceCompleteAllMessages,
    clear,
  };
}
