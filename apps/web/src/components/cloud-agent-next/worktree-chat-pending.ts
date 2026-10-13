import { getOpenWorktreeChatSessionIds } from './worktree-chat-tabs';

export type PendingWorktreeChat = {
  tabId: string;
  worktreeId: string;
  sourceKiloSessionId: string;
  placement: 'append' | 'replace';
  /** The creation still owns the foreground selection. Released once and never re-acquired. */
  owned: boolean;
  resolvedKiloSessionId: string | null;
  /** `getCloudChatLocationKey` of the page the creation started from. */
  originLocationKey: string;
};

export type CloudChatLocation = {
  key: string;
  sessionId: string | null;
};

export function getCloudChatLocationKey(
  pathname: string,
  sessionId: string | null,
  worktreeId: string | null
): string {
  return JSON.stringify([pathname, sessionId, worktreeId]);
}

/**
 * Whether the user has left the page the creation started from by any route
 * (sidebar, Back/Forward, a redirect). The completion's own navigation to the
 * created session is not a departure.
 */
export function hasLeftPendingWorktreeChatOrigin(
  pending: PendingWorktreeChat | null,
  location: CloudChatLocation
): boolean {
  if (!pending?.owned) return false;
  if (pending.resolvedKiloSessionId === null && location.key === pending.originLocationKey) {
    return false;
  }
  return (
    pending.resolvedKiloSessionId === null || location.sessionId !== pending.resolvedKiloSessionId
  );
}

export function releasePendingOwnership(
  pending: PendingWorktreeChat | null
): PendingWorktreeChat | null {
  if (!pending || !pending.owned) return pending;
  return { ...pending, owned: false };
}

export function shouldShowPendingWorktreeView(
  pending: PendingWorktreeChat | null,
  selectedWorktreeId: string | null
): boolean {
  return Boolean(pending?.owned && pending.worktreeId === selectedWorktreeId);
}

/**
 * The open tab order for the SOURCE worktree at creation settlement. Derived from
 * the existing tab preference data (`sessionOrderByWorktree` + `closedSessionIds`)
 * and the worktree's known sessions, so a close or reopen during the request is
 * honored and unrelated worktrees are not disturbed.
 */
export function getLiveSourceOpenSessionIds(args: {
  worktreeSessionIds: readonly string[];
  closedSessionIds: readonly string[];
  sessionOrder: readonly string[];
}): string[] {
  return getOpenWorktreeChatSessionIds(
    args.worktreeSessionIds,
    args.closedSessionIds,
    args.sessionOrder
  );
}
