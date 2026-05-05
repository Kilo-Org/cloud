type MessageHistoryContentState = 'loading' | 'error' | 'ready';

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
  if (isError) {
    return 'error';
  }
  if (!hasData) {
    return 'loading';
  }
  return 'ready';
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
