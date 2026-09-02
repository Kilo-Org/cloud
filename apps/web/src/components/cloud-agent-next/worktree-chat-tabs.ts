import { z } from 'zod';

const CLOSED_WORKTREE_CHAT_TABS_STORAGE_KEY_PREFIX = 'cloud-agent:closed-worktree-chat-tabs';

const sessionIdsSchema = z.array(z.string()).transform(sessionIds => [...new Set(sessionIds)]);
const worktreeChatTabsSchema = z.object({
  closedSessionIds: sessionIdsSchema,
  sessionOrderByWorktree: z.record(z.string(), sessionIdsSchema),
});

export type WorktreeChatTabsState = z.infer<typeof worktreeChatTabsSchema>;

export type WorktreeChatTabsAction =
  | { type: 'open'; sessionId: string }
  | { type: 'close'; sessionId: string }
  | { type: 'forgetWorktree'; worktreeId: string; sessionIds: readonly string[] }
  | {
      type: 'replace';
      worktreeId: string;
      oldSessionId: string;
      newSessionId: string;
      openSessionIds: readonly string[];
    };

export function getClosedWorktreeChatTabsStorageKey(
  userId: string | null | undefined,
  organizationId?: string
): string | null {
  if (!userId) return null;

  const scope = organizationId ? `organization:${encodeURIComponent(organizationId)}` : 'personal';
  return `${CLOSED_WORKTREE_CHAT_TABS_STORAGE_KEY_PREFIX}:user:${encodeURIComponent(userId)}:${scope}`;
}

export function parseWorktreeChatTabs(rawValue: string | null): WorktreeChatTabsState {
  const emptyState: WorktreeChatTabsState = { closedSessionIds: [], sessionOrderByWorktree: {} };
  if (!rawValue) return emptyState;

  try {
    const parsed: unknown = JSON.parse(rawValue);
    const result = worktreeChatTabsSchema.safeParse(
      Array.isArray(parsed) ? { closedSessionIds: parsed, sessionOrderByWorktree: {} } : parsed
    );
    return result.success ? result.data : emptyState;
  } catch {
    return emptyState;
  }
}

export function reduceWorktreeChatTabs(
  state: WorktreeChatTabsState,
  action: WorktreeChatTabsAction
): WorktreeChatTabsState {
  switch (action.type) {
    case 'open':
      return state.closedSessionIds.includes(action.sessionId)
        ? {
            ...state,
            closedSessionIds: state.closedSessionIds.filter(
              sessionId => sessionId !== action.sessionId
            ),
          }
        : state;
    case 'close':
      return state.closedSessionIds.includes(action.sessionId)
        ? state
        : { ...state, closedSessionIds: [...state.closedSessionIds, action.sessionId] };
    case 'forgetWorktree': {
      const deletedIds = new Set(action.sessionIds);
      const sessionOrderByWorktree = { ...state.sessionOrderByWorktree };
      delete sessionOrderByWorktree[action.worktreeId];
      return {
        closedSessionIds: state.closedSessionIds.filter(sessionId => !deletedIds.has(sessionId)),
        sessionOrderByWorktree,
      };
    }
    case 'replace': {
      if (action.oldSessionId === action.newSessionId) {
        return reduceWorktreeChatTabs(state, { type: 'open', sessionId: action.newSessionId });
      }

      const closedSessionIds = state.closedSessionIds.filter(
        sessionId => sessionId !== action.newSessionId
      );
      if (!closedSessionIds.includes(action.oldSessionId))
        closedSessionIds.push(action.oldSessionId);

      const sessionOrder = action.openSessionIds.includes(action.oldSessionId)
        ? action.openSessionIds.flatMap(sessionId =>
            sessionId === action.oldSessionId
              ? [action.newSessionId]
              : sessionId === action.newSessionId
                ? []
                : [sessionId]
          )
        : [...new Set([...action.openSessionIds, action.newSessionId])];
      const previousOrder = state.sessionOrderByWorktree[action.worktreeId] ?? [];
      if (
        closedSessionIds.length === state.closedSessionIds.length &&
        closedSessionIds.every((sessionId, index) => sessionId === state.closedSessionIds[index]) &&
        sessionOrder.length === previousOrder.length &&
        sessionOrder.every((sessionId, index) => sessionId === previousOrder[index])
      ) {
        return state;
      }

      return {
        closedSessionIds,
        sessionOrderByWorktree: {
          ...state.sessionOrderByWorktree,
          [action.worktreeId]: sessionOrder,
        },
      };
    }
  }
}

export function getOpenWorktreeChatSessionIds(
  sessionIds: readonly string[],
  closedSessionIds: readonly string[],
  sessionOrder: readonly string[] = []
): string[] {
  const knownIds = new Set(sessionIds);
  const closedIds = new Set(closedSessionIds);
  return [...new Set([...sessionOrder, ...sessionIds])].filter(
    sessionId => knownIds.has(sessionId) && !closedIds.has(sessionId)
  );
}

export function getClosedWorktreeChatSessionIds(
  sessionIds: readonly string[],
  closedSessionIds: readonly string[]
): string[] {
  const knownIds = new Set(sessionIds);
  return closedSessionIds.toReversed().filter(sessionId => knownIds.has(sessionId));
}

export function getNextOpenChatSessionId(
  openSessionIds: readonly string[],
  closingSessionId: string
): string | null {
  const closingIndex = openSessionIds.indexOf(closingSessionId);
  if (closingIndex === -1) return null;

  return (
    openSessionIds[closingIndex - 1] ??
    openSessionIds.find(sessionId => sessionId !== closingSessionId) ??
    null
  );
}
