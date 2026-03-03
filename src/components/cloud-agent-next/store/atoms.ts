/**
 * Cloud Agent Atoms
 *
 * Jotai atom definitions for cloud agent chat state management.
 * Uses StoredMessage format (info + parts) from OpenNext schema.
 */

import { atom } from 'jotai';
import type { SessionConfig, StoredMessage, Part } from '../types';
import { isMessageStreaming, isAssistantMessage } from '../types';
import type { QuestionInfo } from '@/types/opencode.gen';
import { splitByContiguousPrefix } from '@/lib/utils/splitByContiguousPrefix';
import type { AutocommitStatus } from '@/lib/cloud-agent-next/processor/types';
export type { AutocommitStatus };

// ============================================================================
// Primary State - StoredMessage format
// ============================================================================

/**
 * Map of message ID -> StoredMessage
 * Using a Map for efficient lookups by message ID during streaming updates.
 */
export const messagesMapAtom = atom<Map<string, StoredMessage>>(new Map());

/**
 * Map of part ID -> Part for efficient part lookups
 * Parts are indexed by their ID for fast updates during streaming.
 */
export const partsMapAtom = atom<Map<string, { messageId: string; part: Part }>>(new Map());

/**
 * Map of child session ID -> StoredMessage[]
 * Stores messages from child sessions (subtasks) keyed by their session ID.
 * Used to render child session content inline when expanded.
 */
export const childSessionsMapAtom = atom<Map<string, StoredMessage[]>>(new Map());

/**
 * Map of tool callID -> question requestId.
 * Populated from question.asked events. Used by QuestionToolCard
 * to know which requestId to send when answering/rejecting.
 */
export const questionRequestIdsAtom = atom<Map<string, string>>(new Map());

/**
 * Record a callID -> requestId mapping from a question.asked event.
 */
export const setQuestionRequestIdAtom = atom(
  null,
  (get, set, payload: { callId: string; requestId: string }) => {
    const map = new Map(get(questionRequestIdsAtom));
    map.set(payload.callId, payload.requestId);
    set(questionRequestIdsAtom, map);
  }
);

/**
 * A standalone question from a question.asked event that has no tool.callID.
 * These are questions raised outside the tool-call flow (e.g. PlanFollowup).
 * Only one standalone question can be active at a time.
 */
export type StandaloneQuestion = {
  requestId: string;
  questions: QuestionInfo[];
};

export const standaloneQuestionAtom = atom<StandaloneQuestion | null>(null);

/** Clear the standalone question only if its requestId matches the resolved one. */
export const clearStandaloneQuestionAtom = atom(null, (get, set, resolvedRequestId: string) => {
  const current = get(standaloneQuestionAtom);
  if (current && current.requestId === resolvedRequestId) {
    set(standaloneQuestionAtom, null);
  }
});

/**
 * Session status from session.status events
 * Can be 'idle', 'busy', or 'retry' with additional metadata
 */
export const sessionStatusAtom = atom<
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number }
>({ type: 'idle' });

/**
 * Per-message autocommit status map.
 * Key is the assistant message ID; value is the status for that turn's autocommit.
 * Replaces the old single-value `autocommitStatusAtom` to survive multi-turn replays.
 */
export const autocommitStatusMapAtom = atom<Map<string, AutocommitStatus>>(new Map());

/**
 * Inline session status indicator — shown in the chat feed for recoverable
 * session errors, reconnection states, and interrupts.
 * Non-recoverable errors still go through `errorAtom` → `ErrorBanner`.
 */
export type SessionStatusIndicator = {
  type: 'error' | 'warning' | 'info';
  message: string;
  timestamp: number;
};

export const sessionStatusIndicatorAtom = atom<SessionStatusIndicator | null>(null);

// ============================================================================
// Common State
// ============================================================================

export const currentSessionIdAtom = atom<string | null>(null);
/** Organization ID for the current session (null for personal sessions) */
export const sessionOrganizationIdAtom = atom<string | null>(null);
export const sessionConfigAtom = atom<SessionConfig | null>(null);
export const isStreamingAtom = atom(false);
export const errorAtom = atom<string | null>(null);
export const chatUIAtom = atom({
  shouldAutoScroll: true,
});

// ============================================================================
// Derived Atoms
// ============================================================================

/**
 * Ordered array of StoredMessages derived from messagesMapAtom.
 * Messages are sorted by creation time.
 */
export const messagesListAtom = atom(get => {
  const messagesMap = get(messagesMapAtom);
  const messages = Array.from(messagesMap.values());
  // Sort by creation time
  return messages.sort((a, b) => a.info.time.created - b.info.time.created);
});

/**
 * Split messages into static (complete, contiguous from the start) and dynamic (everything after).
 * A message is complete when its info.time.completed is set (for assistant messages)
 * and all parts have their time.end set.
 */
const splitMessagesAtom = atom(get => {
  const messages = get(messagesListAtom);
  return splitByContiguousPrefix(messages, msg => !isMessageStreaming(msg));
});

export const staticMessagesAtom = atom(get => get(splitMessagesAtom).staticItems);

export const dynamicMessagesAtom = atom(get => get(splitMessagesAtom).dynamicItems);

// Matches CLI's getApiMetrics logic
export const totalCostAtom = atom(get => {
  let totalCost = 0;

  // Calculate cost from assistant messages
  const messagesMap = get(messagesMapAtom);
  messagesMap.forEach(storedMessage => {
    if (isAssistantMessage(storedMessage.info)) {
      totalCost += storedMessage.info.cost;
    }
  });

  return totalCost;
});

export const clearMessagesAtom = atom(null, (_get, set) => {
  set(isStreamingAtom, false);
  set(currentSessionIdAtom, null);
  set(sessionOrganizationIdAtom, null);
  set(errorAtom, null);
  set(messagesMapAtom, new Map());
  set(partsMapAtom, new Map());
  set(questionRequestIdsAtom, new Map());
  set(autocommitStatusMapAtom, new Map());
  set(sessionStatusIndicatorAtom, null);
  set(standaloneQuestionAtom, null);
});

// ============================================================================
// Action Atoms
// ============================================================================

/**
 * Update a message in the messagesMap.
 * Called by the hook when processor emits onMessageUpdated or onMessageCompleted.
 *
 * The processor handles all complexity (pending parts, delta accumulation),
 * so this atom is simple storage - just store what we're given.
 */
export const updateMessageAtom = atom(
  null,
  (get, set, payload: { messageId: string; info: StoredMessage['info']; parts?: Part[] }) => {
    const { messageId, info, parts } = payload;
    const messagesMap = new Map(get(messagesMapAtom));
    const existing = messagesMap.get(messageId);

    if (existing) {
      // Update existing message - merge parts if provided, otherwise keep existing
      messagesMap.set(messageId, {
        info,
        parts: parts ?? existing.parts,
      });
    } else {
      // Create new message
      messagesMap.set(messageId, { info, parts: parts ?? [] });
    }

    set(messagesMapAtom, messagesMap);
  }
);

/**
 * Update a part in a message (in-memory state for UI).
 * Called by the hook when processor emits onPartUpdated.
 *
 * The processor handles delta accumulation, so the part passed here
 * already has the full accumulated text. We just store it.
 */
export const setPartAtom = atom(null, (get, set, payload: { messageId: string; part: Part }) => {
  const { messageId, part } = payload;
  const messagesMap = new Map(get(messagesMapAtom));
  const partsMap = new Map(get(partsMapAtom));
  const existing = messagesMap.get(messageId);

  if (!existing) {
    // Message doesn't exist yet - this shouldn't happen with new architecture
    // since processor ensures message exists before emitting part updates.
    // But handle gracefully by creating a placeholder message.
    console.warn(`updatePartAtom: Message ${messageId} not found, creating placeholder`);
    return;
  }

  // Find or create part
  const partIndex = existing.parts.findIndex(p => p.id === part.id);
  let updatedParts: Part[];

  if (partIndex === -1) {
    // New part - append
    updatedParts = [...existing.parts, part];
  } else {
    // Update existing part - processor already accumulated delta
    updatedParts = [...existing.parts];
    updatedParts[partIndex] = part;
  }

  // Update message in map
  messagesMap.set(messageId, { ...existing, parts: updatedParts });
  set(messagesMapAtom, messagesMap);

  // Update parts index
  partsMap.set(part.id, {
    messageId,
    part: updatedParts[partIndex === -1 ? updatedParts.length - 1 : partIndex],
  });
  set(partsMapAtom, partsMap);
});

/**
 * Remove a part from a message (in-memory state for UI).
 * Called when receiving message.part.removed events.
 */
export const deletePartAtom = atom(
  null,
  (get, set, payload: { messageId: string; partId: string }) => {
    const { messageId, partId } = payload;
    const messagesMap = new Map(get(messagesMapAtom));
    const partsMap = new Map(get(partsMapAtom));
    const existing = messagesMap.get(messageId);

    if (!existing) {
      return;
    }

    const updatedParts = existing.parts.filter(p => p.id !== partId);
    messagesMap.set(messageId, { ...existing, parts: updatedParts });
    set(messagesMapAtom, messagesMap);

    // Remove from parts index
    partsMap.delete(partId);
    set(partsMapAtom, partsMap);
  }
);

/**
 * Create a new user message with proper format.
 * Creates a UserMessage with a text part containing the user's input.
 */
export const addUserMessageAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string;
      content: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
    }
  ): string => {
    const { sessionId, content, agent = 'code', model = { providerID: '', modelID: '' } } = payload;
    const messageId = `optimistic-${crypto.randomUUID()}`;
    const partId = `part_${crypto.randomUUID()}`;
    const now = Date.now();

    const userMessage: StoredMessage = {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: 'user',
        time: {
          created: now,
        },
        agent,
        model,
      },
      parts: [
        {
          type: 'text',
          id: partId,
          sessionID: sessionId,
          messageID: messageId,
          text: content,
          time: {
            start: now,
            end: now,
          },
        },
      ],
    };

    // Add to messagesMap
    const messagesMap = new Map(get(messagesMapAtom));
    messagesMap.set(messageId, userMessage);
    set(messagesMapAtom, messagesMap);

    // Add part to partsMap
    const partsMap = new Map(get(partsMapAtom));
    partsMap.set(partId, { messageId, part: userMessage.parts[0] });
    set(partsMapAtom, partsMap);

    return messageId;
  }
);

/**
 * Remove the optimistic user message (if any) from the store.
 * No-op when no optimistic message exists (avoids unnecessary Map copies / subscriber notifications).
 * Returns true if an optimistic message was found and removed.
 */
export const removeOptimisticMessageAtom = atom(null, (get, set): boolean => {
  const messagesMap = get(messagesMapAtom);

  // Find the optimistic message without copying first
  let optimisticId: string | null = null;
  for (const id of messagesMap.keys()) {
    if (id.startsWith('optimistic-')) {
      optimisticId = id;
      break;
    }
  }
  if (!optimisticId) return false;

  const message = messagesMap.get(optimisticId);
  const newMessagesMap = new Map(messagesMap);
  const newPartsMap = new Map(get(partsMapAtom));

  if (message) {
    for (const part of message.parts) {
      newPartsMap.delete(part.id);
    }
  }
  newMessagesMap.delete(optimisticId);

  set(messagesMapAtom, newMessagesMap);
  set(partsMapAtom, newPartsMap);
  return true;
});

/**
 * Update a message in a child session.
 * Called by the hook when processor emits onChildSessionMessageUpdated.
 *
 * The processor handles pending parts and delta accumulation,
 * so this atom is simple storage.
 */
export const updateChildSessionMessageAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      childSessionId: string;
      messageId: string;
      info: StoredMessage['info'];
      parts?: Part[];
    }
  ) => {
    const { childSessionId, messageId, info, parts } = payload;
    const childSessionsMap = new Map(get(childSessionsMapAtom));
    const existingMessages = childSessionsMap.get(childSessionId) || [];

    const messageIndex = existingMessages.findIndex(m => m.info.id === messageId);
    let updatedMessages: StoredMessage[];

    if (messageIndex === -1) {
      // New message
      updatedMessages = [...existingMessages, { info, parts: parts ?? [] }];
    } else {
      // Update existing message
      updatedMessages = [...existingMessages];
      const existing = updatedMessages[messageIndex];
      updatedMessages[messageIndex] = {
        info,
        parts: parts ?? existing.parts,
      };
    }

    // Sort by creation time
    updatedMessages.sort((a, b) => a.info.time.created - b.info.time.created);

    childSessionsMap.set(childSessionId, updatedMessages);
    set(childSessionsMapAtom, childSessionsMap);
  }
);

/**
 * Update a part in a child session message.
 * Called by the hook when processor emits onChildSessionPartUpdated.
 *
 * The processor handles delta accumulation, so the part passed here
 * already has the full accumulated text.
 */
export const updateChildSessionPartAtom = atom(
  null,
  (get, set, payload: { childSessionId: string; messageId: string; part: Part }) => {
    const { childSessionId, messageId, part } = payload;
    const childSessionsMap = new Map(get(childSessionsMapAtom));
    const existingMessages = childSessionsMap.get(childSessionId) || [];

    const messageIndex = existingMessages.findIndex(m => m.info.id === messageId);
    if (messageIndex === -1) {
      // Message doesn't exist yet - shouldn't happen with new architecture
      console.warn(
        `updateChildSessionPartAtom: Message ${messageId} not found in child session ${childSessionId}`
      );
      return;
    }

    const message = existingMessages[messageIndex];
    const partIndex = message.parts.findIndex(p => p.id === part.id);
    let updatedParts: Part[];

    if (partIndex === -1) {
      // New part - append
      updatedParts = [...message.parts, part];
    } else {
      // Update existing part - processor already accumulated delta
      updatedParts = [...message.parts];
      updatedParts[partIndex] = part;
    }

    const updatedMessages = [...existingMessages];
    updatedMessages[messageIndex] = { ...message, parts: updatedParts };

    childSessionsMap.set(childSessionId, updatedMessages);
    set(childSessionsMapAtom, childSessionsMap);
  }
);

/**
 * Remove a part from a child session message.
 * Called when receiving message.part.removed events where sessionID differs from parent.
 */
export const removeChildSessionPartAtom = atom(
  null,
  (get, set, payload: { childSessionId: string; messageId: string; partId: string }) => {
    const { childSessionId, messageId, partId } = payload;
    const childSessionsMap = new Map(get(childSessionsMapAtom));
    const existingMessages = childSessionsMap.get(childSessionId);

    if (!existingMessages) return;

    const messageIndex = existingMessages.findIndex(m => m.info.id === messageId);
    if (messageIndex === -1) return;

    const message = existingMessages[messageIndex];
    const updatedParts = message.parts.filter(p => p.id !== partId);

    const updatedMessages = [...existingMessages];
    updatedMessages[messageIndex] = { ...message, parts: updatedParts };

    childSessionsMap.set(childSessionId, updatedMessages);
    set(childSessionsMapAtom, childSessionsMap);
  }
);

/**
 * Get messages for a specific child session.
 * Returns empty array if no messages exist for the session.
 */
export const getChildSessionMessagesAtom = atom(get => {
  const childSessionsMap = get(childSessionsMapAtom);
  return (childSessionId: string): StoredMessage[] => {
    return childSessionsMap.get(childSessionId) || [];
  };
});
