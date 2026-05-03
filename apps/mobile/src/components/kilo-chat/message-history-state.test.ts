import { describe, expect, it } from 'vitest';

import { getMessageHistoryContentState } from './message-history-state';

describe('getMessageHistoryContentState', () => {
  it('blocks the composer while the initial history is pending or errored', () => {
    expect(getMessageHistoryContentState({ isPending: true, isError: false, hasData: false })).toBe(
      'loading'
    );

    expect(getMessageHistoryContentState({ isPending: false, isError: true, hasData: false })).toBe(
      'error'
    );
  });

  it('allows the chat surface after the initial history loads', () => {
    expect(getMessageHistoryContentState({ isPending: false, isError: false, hasData: true })).toBe(
      'ready'
    );
  });
});
