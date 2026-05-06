import { buildNewConversationUiState } from './ConversationList';

describe('buildNewConversationUiState', () => {
  it('disables creation while a conversation is pending', () => {
    expect(
      buildNewConversationUiState({
        isCreatingConversation: true,
        newConversationError: null,
      })
    ).toEqual({
      buttonLabel: 'Creating conversation',
      buttonTitle: 'Creating conversation',
      disabled: true,
      emptyText: 'Creating conversation...',
      showError: false,
    });
  });

  it('keeps durable inline error state after a failed creation', () => {
    expect(
      buildNewConversationUiState({
        isCreatingConversation: false,
        newConversationError: "Couldn't create conversation. Check your connection and try again.",
      })
    ).toEqual({
      buttonLabel: 'New conversation',
      buttonTitle: 'New conversation',
      disabled: false,
      emptyText: 'No conversations yet. Create one to start chatting.',
      showError: true,
    });
  });
});
