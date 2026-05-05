import { describe, expect, it } from 'vitest';

import { getConversationListContentState } from './conversation-list-state';

describe('getConversationListContentState', () => {
  it('keeps the empty conversation CTA out of pending and error states', () => {
    expect(
      getConversationListContentState({ isPending: true, isError: false, hasData: false })
    ).toBe('loading');

    expect(
      getConversationListContentState({ isPending: false, isError: true, hasData: false })
    ).toBe('error');
  });

  it('allows the empty conversation CTA only after a successful empty response', () => {
    expect(
      getConversationListContentState({ isPending: false, isError: false, hasData: true })
    ).toBe('ready');
  });
});
