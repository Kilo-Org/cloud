import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppActionRequest } from './app-action-contract';
import {
  getPendingAppAction,
  setPendingAppAction,
  subscribePendingAppAction,
  takePendingAppAction,
} from './pending-app-action';

const OPEN_NEEDS_INPUT: AppActionRequest = { action: 'OpenNeedsInput' };
const OPEN_SESSION: AppActionRequest = { action: 'OpenSession', sessionId: 'ses_1' };

beforeEach(() => {
  takePendingAppAction();
});

describe('pending app action store', () => {
  it('starts empty and peeks without consuming', () => {
    expect(getPendingAppAction()).toBeNull();
    setPendingAppAction(OPEN_NEEDS_INPUT);
    expect(getPendingAppAction()).toEqual(OPEN_NEEDS_INPUT);
    expect(getPendingAppAction()).toEqual(OPEN_NEEDS_INPUT);
  });

  it('takes the request exactly once', () => {
    setPendingAppAction(OPEN_SESSION);
    expect(takePendingAppAction()).toEqual(OPEN_SESSION);
    expect(takePendingAppAction()).toBeNull();
    expect(getPendingAppAction()).toBeNull();
  });

  it('replaces the slot when a newer request arrives', () => {
    setPendingAppAction(OPEN_NEEDS_INPUT);
    setPendingAppAction(OPEN_SESSION);
    expect(takePendingAppAction()).toEqual(OPEN_SESSION);
  });

  it('notifies subscribers on set and on take, and stops after unsubscribe', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribePendingAppAction(listener);
    setPendingAppAction(OPEN_NEEDS_INPUT);
    expect(listener).toHaveBeenCalledTimes(1);
    takePendingAppAction();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setPendingAppAction(OPEN_SESSION);
    takePendingAppAction();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify when there is nothing to take', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribePendingAppAction(listener);
    expect(takePendingAppAction()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
