import { beforeEach, describe, expect, it, vi } from 'vitest';

import { announcingToast } from '@/lib/a11y/announcing-toast';

import { exitRemoteSessionFromList } from './exit-remote-session-from-list';

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));

type RetryAction = { label: string; onClick: () => void };

function createHarness() {
  const confirm = vi.fn(async () => {
    await Promise.resolve();
    return true;
  });
  const sendExit = vi.fn(async () => {
    await Promise.resolve();
  });
  const refreshActiveList = vi.fn(async () => {
    await Promise.resolve();
  });
  const inFlight = { current: false };
  return { confirm, sendExit, refreshActiveList, inFlight };
}

function captureRetryAction(): RetryAction | undefined {
  const call = vi.mocked(announcingToast.error).mock.calls[0];
  const options = call?.[1] as { action?: RetryAction } | undefined;
  return options?.action;
}

describe('exitRemoteSessionFromList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels without sending, refreshing, or toasting', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    confirm.mockResolvedValue(false);

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sendExit).not.toHaveBeenCalled();
    expect(refreshActiveList).not.toHaveBeenCalled();
    expect(announcingToast.success).not.toHaveBeenCalled();
    expect(announcingToast.error).not.toHaveBeenCalled();
    expect(inFlight.current).toBe(false);
  });

  it('sends, toasts success, refreshes, and releases the flag', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sendExit).toHaveBeenCalledTimes(1);
    expect(announcingToast.success).toHaveBeenCalledWith('Session exited');
    expect(announcingToast.error).not.toHaveBeenCalled();
    expect(refreshActiveList).toHaveBeenCalledTimes(1);
    expect(inFlight.current).toBe(false);
  });

  it('swallows a refresh failure after a successful send without resending', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    refreshActiveList.mockRejectedValue(new Error('network down'));

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    expect(sendExit).toHaveBeenCalledTimes(1);
    expect(announcingToast.success).toHaveBeenCalledTimes(1);
    expect(announcingToast.success).toHaveBeenCalledWith('Session exited');
    expect(announcingToast.error).not.toHaveBeenCalled();
    expect(inFlight.current).toBe(false);
  });

  it('shows a Try again toast on a retryable send failure without refreshing', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    sendExit.mockRejectedValue(new Error('Invalid exit_cli response'));

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    expect(sendExit).toHaveBeenCalledTimes(1);
    expect(announcingToast.error).toHaveBeenCalledWith('Invalid exit_cli response', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
    expect(announcingToast.success).not.toHaveBeenCalled();
    expect(refreshActiveList).not.toHaveBeenCalled();
    expect(inFlight.current).toBe(false);
  });

  it('resends from Try again without a second confirm and holds the flag in flight', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    const retryResolveRef = { resolve: undefined as (() => void) | undefined };
    sendExit.mockImplementation(async () => {
      await Promise.resolve();
      if (sendExit.mock.calls.length === 1) {
        throw new Error('connection reset');
      }
      await new Promise<void>(resolve => {
        retryResolveRef.resolve = resolve;
      });
    });

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    const action = captureRetryAction();
    if (!action) {
      throw new Error('Expected retry action on the toast');
    }

    action.onClick();
    await vi.waitFor(() => {
      expect(sendExit).toHaveBeenCalledTimes(2);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(inFlight.current).toBe(true);

    retryResolveRef.resolve?.();
    await vi.waitFor(() => {
      expect(inFlight.current).toBe(false);
    });
    expect(announcingToast.success).toHaveBeenCalledTimes(1);
  });

  it('ignores a second Try again tap while the retry send is in flight', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    const retryResolveRef = { resolve: undefined as (() => void) | undefined };
    sendExit.mockImplementation(async () => {
      await Promise.resolve();
      if (sendExit.mock.calls.length === 1) {
        throw new Error('connection reset');
      }
      await new Promise<void>(resolve => {
        retryResolveRef.resolve = resolve;
      });
    });

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    const action = captureRetryAction();
    if (!action) {
      throw new Error('Expected retry action on the toast');
    }

    action.onClick();
    await vi.waitFor(() => {
      expect(sendExit).toHaveBeenCalledTimes(2);
    });
    expect(inFlight.current).toBe(true);

    action.onClick();
    expect(sendExit).toHaveBeenCalledTimes(2);
    expect(inFlight.current).toBe(true);

    retryResolveRef.resolve?.();
    await vi.waitFor(() => {
      expect(inFlight.current).toBe(false);
    });
    expect(sendExit).toHaveBeenCalledTimes(2);
    expect(announcingToast.success).toHaveBeenCalledTimes(1);
  });

  it('shows a non-retryable message with no action and does not resend', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    sendExit.mockRejectedValue(
      new Error('Remote session exit is not supported for the current session')
    );

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    expect(sendExit).toHaveBeenCalledTimes(1);
    expect(announcingToast.error).toHaveBeenCalledWith(
      'Remote session exit is not supported for the current session'
    );
    const options = vi.mocked(announcingToast.error).mock.calls[0]?.[1] as
      | { action?: RetryAction }
      | undefined;
    expect(options?.action).toBeUndefined();
    expect(announcingToast.success).not.toHaveBeenCalled();
    expect(refreshActiveList).not.toHaveBeenCalled();
    expect(inFlight.current).toBe(false);
  });

  it('falls back to Failed to exit session for a non-Error throw', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    class NotAnError {
      message = 'opaque';
    }
    sendExit.mockImplementation(async () => {
      await Promise.resolve();
      // oxlint-disable-next-line typescript-eslint/only-throw-error
      throw new NotAnError();
    });

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    expect(sendExit).toHaveBeenCalledTimes(1);
    expect(announcingToast.error).toHaveBeenCalledWith('Failed to exit session', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
  });

  it('returns without confirming when already in flight', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    inFlight.current = true;

    await exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });

    expect(confirm).not.toHaveBeenCalled();
    expect(sendExit).not.toHaveBeenCalled();
    expect(refreshActiveList).not.toHaveBeenCalled();
    expect(announcingToast.success).not.toHaveBeenCalled();
    expect(announcingToast.error).not.toHaveBeenCalled();
  });

  it('releases the flag after a pending send settles', async () => {
    const { confirm, sendExit, refreshActiveList, inFlight } = createHarness();
    const sendResolveRef = { resolve: undefined as (() => void) | undefined };
    sendExit.mockImplementation(async () => {
      await new Promise<void>(resolve => {
        sendResolveRef.resolve = resolve;
      });
    });

    const pending = exitRemoteSessionFromList({ confirm, sendExit, refreshActiveList, inFlight });
    await vi.waitFor(() => {
      expect(sendExit).toHaveBeenCalledTimes(1);
    });
    expect(inFlight.current).toBe(true);

    sendResolveRef.resolve?.();
    await pending;
    expect(inFlight.current).toBe(false);
    expect(announcingToast.success).toHaveBeenCalledTimes(1);
  });
});
