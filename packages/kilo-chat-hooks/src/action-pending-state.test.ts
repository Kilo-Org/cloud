import { describe, expect, it } from 'vitest';

import {
  clearPendingAction,
  pendingActionGroupIdForMessage,
  tryStartPendingAction,
  type PendingActionStore,
} from './action-pending-state';

describe('pending action state', () => {
  it('exposes pending group identity only for the matching message row', () => {
    const pendingAction = { messageId: 'message-1', groupId: 'approval-1' };

    expect(pendingActionGroupIdForMessage(pendingAction, 'message-1')).toBe('approval-1');
    expect(pendingActionGroupIdForMessage(pendingAction, 'message-2')).toBeNull();
    expect(pendingActionGroupIdForMessage(null, 'message-1')).toBeNull();
  });

  it('preserves one-action-in-flight duplicate-submit protection', () => {
    const store: PendingActionStore = { current: null };
    const firstAction = { messageId: 'message-1', groupId: 'approval-1' };
    const secondAction = { messageId: 'message-2', groupId: 'approval-2' };

    expect(tryStartPendingAction(store, firstAction)).toBe(true);
    expect(store.current).toEqual(firstAction);
    expect(tryStartPendingAction(store, secondAction)).toBe(false);
    expect(store.current).toEqual(firstAction);

    clearPendingAction(store, secondAction);
    expect(store.current).toEqual(firstAction);

    clearPendingAction(store, firstAction);
    expect(store.current).toBeNull();
    expect(tryStartPendingAction(store, secondAction)).toBe(true);
    expect(store.current).toEqual(secondAction);
  });
});
