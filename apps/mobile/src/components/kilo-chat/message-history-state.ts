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
