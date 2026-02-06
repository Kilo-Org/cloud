/**
 * Event Processor Types
 *
 * Type definitions for the framework-agnostic event processor.
 * These types define the callback interface for state change notifications
 * and the configuration for creating an EventProcessor.
 */

import type {
  Part,
  SessionStatus,
  Session,
  UserMessage,
  AssistantMessage,
} from '@/types/opencode.gen';

/**
 * Message format used by the processor.
 * Contains message metadata (info) and an array of content parts.
 */
export type ProcessedMessage = {
  info: UserMessage | AssistantMessage;
  parts: Part[];
};

/**
 * Callbacks for state change notifications.
 * All callbacks are optional - only subscribe to what you need.
 *
 * Message lifecycle:
 * - While streaming: onMessageUpdated/onPartUpdated called as data arrives
 * - When complete: onMessageCompleted called with final message, then removed from processor
 *
 * All message/part callbacks include sessionId and parentSessionId:
 * - parentSessionId is null for root session messages
 * - parentSessionId is the parent's session ID for child/subsession messages
 */
export type EventProcessorCallbacks = {
  /** Called when a message is created or updated (while streaming) */
  onMessageUpdated?: (
    sessionId: string,
    messageId: string,
    message: ProcessedMessage,
    parentSessionId: string | null
  ) => void;

  /** Called when a message is complete (all parts finished, info.time.completed set for assistant) */
  onMessageCompleted?: (
    sessionId: string,
    messageId: string,
    message: ProcessedMessage,
    parentSessionId: string | null
  ) => void;

  /** Called when a part is added or updated within a message */
  onPartUpdated?: (
    sessionId: string,
    messageId: string,
    partId: string,
    part: Part,
    parentSessionId: string | null
  ) => void;

  /** Called when a part is removed from a message */
  onPartRemoved?: (
    sessionId: string,
    messageId: string,
    partId: string,
    parentSessionId: string | null
  ) => void;

  /** Called when session status changes (idle/busy/retry) */
  onSessionStatusChanged?: (status: SessionStatus) => void;

  /** Called when a new session is created (session.created event) */
  onSessionCreated?: (sessionInfo: Session) => void;

  /** Called when session info is updated (session.updated event) */
  onSessionUpdated?: (sessionInfo: Session) => void;

  /** Called when an error event is received */
  onError?: (error: string, sessionId?: string) => void;

  /** Called when streaming state changes */
  onStreamingChanged?: (isStreaming: boolean) => void;
};

/**
 * Configuration for creating an EventProcessor.
 */
export type EventProcessorConfig = {
  callbacks?: EventProcessorCallbacks;
};
