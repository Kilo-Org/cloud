import { buildConversationListUiState } from './ConversationList';

describe('buildConversationListUiState', () => {
  it('disables creation while a conversation is pending', () => {
    expect(
      buildConversationListUiState({
        isCreatingConversation: true,
        newConversationError: null,
      })
    ).toEqual({
      buttonLabel: 'Creating conversation',
      buttonTitle: 'Creating conversation',
      disabled: true,
      emptyText: 'Creating conversation...',
      historyErrorText: null,
      showError: false,
    });
  });

  it('keeps creation pending while history also reports an error', () => {
    expect(
      buildConversationListUiState({
        hasConversationHistoryError: true,
        isCreatingConversation: true,
        newConversationError: null,
      })
    ).toEqual({
      buttonLabel: 'Creating conversation',
      buttonTitle: 'Creating conversation',
      disabled: true,
      emptyText: 'Creating conversation...',
      historyErrorText: null,
      showError: false,
    });
  });

  it('marks creation errors as visible when no history error is present', () => {
    expect(
      buildConversationListUiState({
        isCreatingConversation: false,
        newConversationError: "Couldn't create conversation. Check your connection and try again.",
      })
    ).toEqual({
      buttonLabel: 'New conversation',
      buttonTitle: 'New conversation',
      disabled: false,
      emptyText: 'No conversations yet. Create one to start chatting.',
      historyErrorText: null,
      showError: true,
    });
  });

  it('shows history load failure text instead of an empty-history state', () => {
    expect(
      buildConversationListUiState({
        hasConversationHistoryError: true,
        isCreatingConversation: false,
        newConversationError: null,
      })
    ).toEqual({
      buttonLabel: 'New conversation',
      buttonTitle: 'New conversation',
      disabled: false,
      emptyText: 'Failed to load conversations',
      historyErrorText: 'Failed to load conversations',
      showError: false,
    });
  });

  it('keeps the creation failure visible alongside a history load failure', () => {
    expect(
      buildConversationListUiState({
        hasConversationHistoryError: true,
        isCreatingConversation: false,
        newConversationError: "Couldn't create conversation. Check your connection and try again.",
      })
    ).toEqual({
      buttonLabel: 'New conversation',
      buttonTitle: 'New conversation',
      disabled: false,
      emptyText: 'Failed to load conversations',
      historyErrorText: 'Failed to load conversations',
      showError: true,
    });
  });
});
