import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppActionRequest } from './app-action-contract';
import {
  _resetPendingAppActionForTests,
  clearAccountBoundPendingAppAction,
  getPendingAppAction,
  setCurrentAppActionUserId,
  setPendingAppAction,
  subscribePendingAppAction,
  takePendingAppAction,
} from './pending-app-action';

const OPEN_NEEDS_INPUT: AppActionRequest = { action: 'OpenNeedsInput' };
const OPEN_SESSION: AppActionRequest = { action: 'OpenSession', sessionId: 'ses_1' };

beforeEach(() => {
  _resetPendingAppActionForTests();
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

describe('pending app action account binding', () => {
  it('drops an account-bound request when a different account signs in', () => {
    setCurrentAppActionUserId('user_a');
    setPendingAppAction(OPEN_SESSION);
    setCurrentAppActionUserId('user_b');
    expect(getPendingAppAction()).toBeNull();
  });

  it('keeps a request bound to the same account', () => {
    setCurrentAppActionUserId('user_a');
    setPendingAppAction(OPEN_SESSION);
    setCurrentAppActionUserId('user_a');
    expect(getPendingAppAction()).toEqual(OPEN_SESSION);
  });

  it('drops a request parked while signed out when an account signs in', () => {
    setCurrentAppActionUserId(null);
    setPendingAppAction(OPEN_SESSION);
    setCurrentAppActionUserId('user_b');
    expect(getPendingAppAction()).toBeNull();
  });

  it('adopts a request parked before the account is known when a user settles', () => {
    setPendingAppAction(OPEN_SESSION);
    setCurrentAppActionUserId('user_b');
    expect(getPendingAppAction()).toEqual(OPEN_SESSION);
  });

  it('drops a request parked before the account settles signed out', () => {
    setPendingAppAction(OPEN_SESSION);
    setCurrentAppActionUserId(null);
    expect(getPendingAppAction()).toBeNull();
  });

  it('clearAccountBoundPendingAppAction drops an account-bound request', () => {
    setCurrentAppActionUserId('user_a');
    setPendingAppAction(OPEN_SESSION);
    clearAccountBoundPendingAppAction();
    expect(getPendingAppAction()).toBeNull();
  });

  it('clearAccountBoundPendingAppAction keeps a signed-out request', () => {
    setCurrentAppActionUserId(null);
    setPendingAppAction(OPEN_SESSION);
    clearAccountBoundPendingAppAction();
    expect(getPendingAppAction()).toEqual(OPEN_SESSION);
  });
});
