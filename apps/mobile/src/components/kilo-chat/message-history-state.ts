type MessageHistoryContentState = 'loading' | 'error' | 'ready' | 'stale-error';

export function getMessageHistoryContentState({
  isPending,
  isError,
  hasData,
}: {
  isPending: boolean;
  isError: boolean;
  hasData: boolean;
}): MessageHistoryContentState {
  if (isPending) {
    return 'loading';
  }
  // Cached data wins: a refetch failure with existing messages is a stale-error
  // (small inline indicator), never a full-screen error that hides history.
  if (hasData) {
    return isError ? 'stale-error' : 'ready';
  }
  if (isError) {
    return 'error';
  }
  return 'loading';
}

export function shouldMarkLatestMessageRead({
  currentUserId,
  latestMessageSenderId,
}: {
  currentUserId: string | null;
  latestMessageSenderId: string | null;
}): boolean {
  if (latestMessageSenderId === null) {
    return false;
  }
  return currentUserId === null || latestMessageSenderId !== currentUserId;
}
