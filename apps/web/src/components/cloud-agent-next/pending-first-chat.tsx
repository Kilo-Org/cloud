'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * The first prompt of a session, carried across the NewSessionPanel → chat route
 * navigation so the chat opens with the prompt already visible instead of an
 * opening skeleton. Bound to the real session id only after prepare returns.
 */
export type PendingFirstChat = {
  operationKey: string;
  initialMessageId: string;
  prompt: string;
  attachmentNames: string[];
  kiloSessionId: string | null;
};

/**
 * One label for the whole wait, on both sides of the route change, so the
 * status row does not change text while only the hosting page changes.
 */
export const PENDING_FIRST_CHAT_STATUS_LABEL = 'Creating session…';

type PendingFirstChatContextValue = {
  pendingFirstChat: PendingFirstChat | null;
  setPendingFirstChat: (next: PendingFirstChat | null) => void;
};

const PendingFirstChatContext = createContext<PendingFirstChatContextValue>({
  pendingFirstChat: null,
  setPendingFirstChat: () => {},
});

export function PendingFirstChatProvider({ children }: { children: ReactNode }) {
  const [pendingFirstChat, setPendingFirstChat] = useState<PendingFirstChat | null>(null);
  const value = useMemo(() => ({ pendingFirstChat, setPendingFirstChat }), [pendingFirstChat]);
  return (
    <PendingFirstChatContext.Provider value={value}>{children}</PendingFirstChatContext.Provider>
  );
}

export function usePendingFirstChat(): PendingFirstChatContextValue {
  return useContext(PendingFirstChatContext);
}

export type PendingFirstChatViewDecision = 'idle' | 'show' | 'clear';

/**
 * Whether the carried first prompt should still stand in for the chat, or the
 * snapshot can be discarded. Display continues until the real row with the same
 * initial message id is visible, so the prompt never disappears between the
 * composer and the chat. Fetched data of another session is ignored: the shared
 * manager still holds the previously open session on the chat route's first
 * render.
 */
export function resolvePendingFirstChatView(args: {
  pending: PendingFirstChat | null;
  requestedSessionId: string | null;
  visibleMessageIds: readonly string[];
  transcriptPhase: 'live' | 'opening' | 'failed';
  hasMessages: boolean;
  fetchedSession: { kiloSessionId: string; initialMessageId: string | null } | null;
}): PendingFirstChatViewDecision {
  const { pending, fetchedSession } = args;
  if (!pending || pending.kiloSessionId === null) return 'idle';
  if (pending.kiloSessionId !== args.requestedSessionId) return 'idle';

  if (args.visibleMessageIds.includes(pending.initialMessageId)) return 'clear';
  if (
    fetchedSession?.kiloSessionId === pending.kiloSessionId &&
    fetchedSession.initialMessageId !== null &&
    fetchedSession.initialMessageId !== pending.initialMessageId
  ) {
    return 'clear';
  }
  if (args.transcriptPhase === 'failed') return 'clear';
  if (args.transcriptPhase === 'live' && args.hasMessages) return 'clear';
  return 'show';
}
