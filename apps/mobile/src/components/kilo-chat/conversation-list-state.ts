type ConversationListContentState = 'loading' | 'error' | 'ready';

export function getConversationListContentState({
  isPending,
  isError,
  hasData,
}: {
  isPending: boolean;
  isError: boolean;
  hasData: boolean;
}): ConversationListContentState {
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
