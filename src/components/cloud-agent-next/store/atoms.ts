/**
 * Cloud Agent Atoms
 *
 * Jotai atoms for cloud agent chat state.
 * Message/part state derives from the SDK's JotaiSessionStorage atoms.
 * UI-only state (questions, indicators, errors) is managed directly.
 */

import { atom } from 'jotai';
import type { JotaiSessionStorage } from '@/lib/cloud-agent-sdk/storage/jotai';
import type { SessionConfig, StoredMessage } from '../types';
import { isMessageStreaming, isAssistantMessage } from '../types';
import type { QuestionInfo } from '@/types/opencode.gen';
import { splitByContiguousPrefix } from '@/lib/utils/splitByContiguousPrefix';
// ============================================================================
// SDK Storage — single source of truth for messages/parts/streamState
// ============================================================================

/**
 * The current session's Jotai-backed storage, set by the stream hook.
 * All message/part derived atoms read from this.
 */
export const sessionStorageAtom = atom<JotaiSessionStorage | null>(null);

/**
 * Tracks parent relationships for sessions: sessionId → parentId (null = root).
 * Used to distinguish root messages from child session messages.
 */
export const sessionParentsAtom = atom<Map<string, string | null>>(new Map());

// ============================================================================
// Optimistic Messages — UI-only, outside SDK storage
// ============================================================================

/**
 * The single optimistic user message shown before the server echoes it back.
 * Lives outside SDK storage because the SDK is append-only (no removeMessage).
 */
export const optimisticMessageAtom = atom<StoredMessage | null>(null);

/** Create an optimistic user message. Returns the message ID. */
export const addUserMessageAtom = atom(
  null,
  (
    _get,
    set,
    payload: {
      sessionId: string;
      content: string;
      agent?: string;
    }
  ): string => {
    const { sessionId, content, agent = 'code' } = payload;
    const messageId = `optimistic-${crypto.randomUUID()}`;
    const partId = `part_${crypto.randomUUID()}`;
    const now = Date.now();

    set(optimisticMessageAtom, {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: now },
        agent,
        model: { providerID: '', modelID: '' },
      },
      parts: [
        {
          type: 'text' as const,
          id: partId,
          sessionID: sessionId,
          messageID: messageId,
          text: content,
          time: { start: now, end: now },
        },
      ],
    } satisfies StoredMessage);

    return messageId;
  }
);

/** Remove the optimistic message. Returns true if one was present. */
export const removeOptimisticMessageAtom = atom(null, (get, set): boolean => {
  if (!get(optimisticMessageAtom)) return false;
  set(optimisticMessageAtom, null);
  return true;
});

// ============================================================================
// Derived Message Atoms — read from SDK storage + optimistic message
// ============================================================================

/**
 * Ordered array of all messages (SDK storage + optimistic).
 * SDK messageIds are already time-sorted ascending.
 */
export const messagesListAtom = atom<StoredMessage[]>(get => {
  const storage = get(sessionStorageAtom);
  const optimistic = get(optimisticMessageAtom);
  const parents = get(sessionParentsAtom);

  const messages: StoredMessage[] = [];

  if (storage) {
    const messageIds = get(storage.atoms.messageIds);
    const messagesMap = get(storage.atoms.messages);
    const partsMap = get(storage.atoms.parts);

    for (const id of messageIds) {
      const info = messagesMap.get(id);
      if (!info) continue;
      // Skip child session messages — they render inside ChildSessionSection
      const parent = parents.get(info.sessionID);
      if (parent !== undefined && parent !== null) continue;
      messages.push({ info, parts: partsMap.get(id) ?? [] } satisfies StoredMessage);
    }
  }

  if (optimistic) {
    messages.push(optimistic);
  }

  return messages;
});

/**
 * Split messages into static (complete, contiguous from the start) and dynamic (the rest).
 * Static messages are memoized in the renderer to skip re-renders during streaming.
 */
const splitMessagesAtom = atom(get => {
  const messages = get(messagesListAtom);
  return splitByContiguousPrefix(messages, msg => !isMessageStreaming(msg));
});

export const staticMessagesAtom = atom(get => get(splitMessagesAtom).staticItems);
export const dynamicMessagesAtom = atom(get => get(splitMessagesAtom).dynamicItems);

export const totalCostAtom = atom(get => {
  let cost = 0;
  for (const msg of get(messagesListAtom)) {
    if (isAssistantMessage(msg.info)) {
      cost += msg.info.cost;
    }
  }
  return cost;
});

/**
 * Get messages for a child session, derived from SDK storage.
 * Groups SDK messages by sessionID, returning only those from child sessions.
 */
export const getChildSessionMessagesAtom = atom(get => {
  const storage = get(sessionStorageAtom);
  const parents = get(sessionParentsAtom);

  if (!storage) return (_childSessionId: string): StoredMessage[] => [];

  const messageIds = get(storage.atoms.messageIds);
  const messagesMap = get(storage.atoms.messages);
  const partsMap = get(storage.atoms.parts);

  // Group messages by sessionID for child sessions
  const childMap = new Map<string, StoredMessage[]>();
  for (const id of messageIds) {
    const info = messagesMap.get(id);
    if (!info) continue;
    const parent = parents.get(info.sessionID);
    // Child = parent is a non-null string (not undefined/null)
    if (parent !== undefined && parent !== null) {
      let msgs = childMap.get(info.sessionID);
      if (!msgs) {
        msgs = [];
        childMap.set(info.sessionID, msgs);
      }
      msgs.push({ info, parts: partsMap.get(id) ?? [] } satisfies StoredMessage);
    }
  }

  return (childSessionId: string): StoredMessage[] => {
    return childMap.get(childSessionId) ?? [];
  };
});

// ============================================================================
// UI State — not derived from SDK storage
// ============================================================================

export const questionRequestIdsAtom = atom<Map<string, string>>(new Map());

export const setQuestionRequestIdAtom = atom(
  null,
  (get, set, payload: { callId: string; requestId: string }) => {
    const map = new Map(get(questionRequestIdsAtom));
    map.set(payload.callId, payload.requestId);
    set(questionRequestIdsAtom, map);
  }
);

export type StandaloneQuestion = {
  requestId: string;
  questions: QuestionInfo[];
};

export const standaloneQuestionAtom = atom<StandaloneQuestion | null>(null);

export const clearStandaloneQuestionAtom = atom(null, (get, set, resolvedRequestId: string) => {
  const current = get(standaloneQuestionAtom);
  if (current && current.requestId === resolvedRequestId) {
    set(standaloneQuestionAtom, null);
  }
});

export type SessionStatusIndicator = {
  type: 'error' | 'warning' | 'info' | 'progress';
  message: string;
  timestamp: number;
};

export const sessionStatusIndicatorAtom = atom<SessionStatusIndicator | null>(null);

export const currentSessionIdAtom = atom<string | null>(null);
export const sessionOrganizationIdAtom = atom<string | null>(null);
export const sessionConfigAtom = atom<SessionConfig | null>(null);
/** Set by the stream hook when ServiceState activity is 'busy'. */
export const isStreamingAtom = atom(false);
export const errorAtom = atom<string | null>(null);
export const chatUIAtom = atom({ shouldAutoScroll: true });

// ============================================================================
// Reset
// ============================================================================

export const clearMessagesAtom = atom(null, (get, set) => {
  const storage = get(sessionStorageAtom);
  if (storage) storage.clear();
  set(optimisticMessageAtom, null);
  set(currentSessionIdAtom, null);
  set(sessionOrganizationIdAtom, null);
  set(errorAtom, null);
  set(isStreamingAtom, false);
  set(questionRequestIdsAtom, new Map());
  set(sessionStatusIndicatorAtom, null);
  set(standaloneQuestionAtom, null);
  set(sessionParentsAtom, new Map());
});
