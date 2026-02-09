/**
 * Cloud Agent Atoms
 *
 * Jotai atom definitions for cloud agent chat state management.
 * Uses StoredMessage format (info + parts) from OpenNext schema.
 */

import { atom } from 'jotai';
import type { SessionConfig, StoredMessage, Part } from '../types';
import { isMessageStreaming, isAssistantMessage } from '../types';

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
 * Session status from session.status events
 * Can be 'idle', 'busy', or 'retry' with additional metadata
 */
export const sessionStatusAtom = atom<
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number }
>({ type: 'idle' });

// ============================================================================
// Common State
// ============================================================================

export const currentSessionIdAtom = atom<string | null>(null);
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
 * Static messages - all complete messages that can be memoized.
 * A message is complete when its info.time.completed is set (for assistant messages)
 * and all parts have their time.end set.
 */
export const staticMessagesAtom = atom(get => {
  const messages = get(messagesListAtom);
  const { staticMessages } = splitMessages(messages);
  return staticMessages;
});

/**
 * Dynamic messages - messages that are still streaming.
 */
export const dynamicMessagesAtom = atom(get => {
  const messages = get(messagesListAtom);
  const { dynamicMessages } = splitMessages(messages);
  return dynamicMessages;
});

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
  set(errorAtom, null);
  set(messagesMapAtom, new Map());
  set(partsMapAtom, new Map());
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
  ) => {
    const { sessionId, content, agent = 'code', model = { providerID: '', modelID: '' } } = payload;
    const messageId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const partId = `part_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
  }
);

/**
 * Clear all streaming state atoms.
 * Resets messagesMapAtom, partsMapAtom, childSessionsMapAtom, and sessionStatusAtom to initial state.
 */
export const clearStreamingStateAtom = atom(null, (_get, set) => {
  set(messagesMapAtom, new Map());
  set(partsMapAtom, new Map());
  set(childSessionsMapAtom, new Map());
  set(sessionStatusAtom, { type: 'idle' });
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

// Splits messages into static (complete) and dynamic (streaming) groups
function splitMessages(messages: StoredMessage[]): {
  staticMessages: StoredMessage[];
  dynamicMessages: StoredMessage[];
} {
  let lastCompleteIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    if (!isMessageStreaming(messages[i])) {
      if (i === 0 || i === lastCompleteIndex + 1) {
        lastCompleteIndex = i;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return {
    staticMessages: messages.slice(0, lastCompleteIndex + 1),
    dynamicMessages: messages.slice(lastCompleteIndex + 1),
  };
}
