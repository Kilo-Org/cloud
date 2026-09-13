import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import {
  exitRemoteSessionWithFeedback,
  type RetryableExitFailure,
} from '@/components/agents/exit-remote-session-with-feedback';

const SESSIONS_ROUTE = '/(app)/(tabs)/(2_agents)';

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function createLock() {
  return { current: false };
}

function createHarness() {
  const order: string[] = [];
  const onAccepted = vi.fn(() => {
    order.push('accepted');
  });
  const router = {
    dismissTo: vi.fn(() => order.push('dismissTo')),
  };
  const lock = createLock();
  return { order, onAccepted, router, lock };
}

describe('exitRemoteSessionWithFeedback — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Session exited", calls onAccepted, and navigates to the sessions route', async () => {
    const { order, onAccepted, router, lock } = createHarness();
    const exit = vi.fn(async () => {
      order.push('exit');
      await Promise.resolve();
    });

    await exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Session exited');
    expect(toast.error).not.toHaveBeenCalled();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).toHaveBeenCalledWith(SESSIONS_ROUTE);
    expect(order).toEqual(['exit', 'accepted', 'dismissTo']);
    expect(lock.current).toBe(false);
  });
});

describe('exitRemoteSessionWithFeedback — retryable error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a "Try again" toast action, does not navigate, and rethrows on transport failure', async () => {
    const { onAccepted, router, lock } = createHarness();
    const transportError = new Error('Invalid exit_cli response');
    const exit = vi.fn(async () => {
      await Promise.resolve();
      throw transportError;
    });

    await expect(exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock })).rejects.toBe(
      transportError
    );

    expect(exit).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Invalid exit_cli response', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(lock.current).toBe(false);
  });

  it('re-runs the exit mutation when the "Try again" action is clicked', async () => {
    const { onAccepted, router, lock } = createHarness();
    const exit = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('connection reset');
    });

    await expect(exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock })).rejects.toThrow(
      'connection reset'
    );

    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    if (!options?.action || typeof options.action !== 'object' || !('onClick' in options.action)) {
      throw new Error('Expected retry action on the toast');
    }

    options.action.onClick();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(2);
    });
    expect(lock.current).toBe(false);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it('does not start a second exit mutation while a retry is pending', async () => {
    const { onAccepted, router, lock } = createHarness();
    const exitPromiseRef = { resolve: undefined as (() => void) | undefined };
    const exit = vi.fn(async () => {
      await Promise.resolve();
      if (exit.mock.calls.length === 1) {
        throw new Error('connection reset');
      }
      // The retry (second call) hangs until the test resolves it.
      await new Promise<void>(resolve => {
        exitPromiseRef.resolve = resolve;
      });
    });

    await expect(exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock })).rejects.toThrow(
      'connection reset'
    );

    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    if (!options?.action || typeof options.action !== 'object' || !('onClick' in options.action)) {
      throw new Error('Expected retry action on the toast');
    }

    options.action.onClick();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(2);
    });
    expect(lock.current).toBe(true);

    // A second tap while the retry is in-flight must be rejected by the lock
    // and not start a third exit mutation.
    options.action.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.current).toBe(true);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();

    exitPromiseRef.resolve?.();
    await vi.waitFor(() => {
      expect(lock.current).toBe(false);
    });
  });

  it('uses the generic fallback message for non-Error throws', async () => {
    const { onAccepted, router, lock } = createHarness();
    // The classifier must fall back to a generic message when the thrown
    // value is not an Error instance. A non-Error class exercises that
    // branch while keeping the throw a `new` expression (so the
    // no-throw-literal rule stays satisfied).
    class NotAnError {
      message = 'opaque';
    }
    const exit = vi.fn(async () => {
      await Promise.resolve();
      // oxlint-disable-next-line typescript-eslint/only-throw-error
      throw new NotAnError();
    });

    await expect(
      exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock })
    ).rejects.toBeInstanceOf(NotAnError);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Failed to exit session', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
  });
});

describe('exitRemoteSessionWithFeedback — host-owned retryable failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands the failure to onRetryableFailure instead of a toast and retries to success', async () => {
    const { onAccepted, router, lock } = createHarness();
    const exit = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(undefined);
    const onRetryableFailure = vi.fn<(failure: RetryableExitFailure) => void>();

    await expect(
      exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock, onRetryableFailure })
    ).rejects.toThrow('connection reset');

    // The durable surface owns the feedback: no transient toast, no CTA toast.
    expect(toast.error).not.toHaveBeenCalled();
    expect(onRetryableFailure).toHaveBeenCalledTimes(1);
    const failure = onRetryableFailure.mock.calls[0]?.[0];
    if (!failure) {
      throw new Error('Expected the retryable failure');
    }
    expect(failure.message).toBe('connection reset');

    await failure.retry();

    expect(exit).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith('Session exited');
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).toHaveBeenCalledWith(SESSIONS_ROUTE);
    expect(lock.current).toBe(false);
  });

  it('reports a repeated retry failure back through onRetryableFailure', async () => {
    const { onAccepted, router, lock } = createHarness();
    const exit = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('still down'));
    const onRetryableFailure = vi.fn<(failure: RetryableExitFailure) => void>();

    await expect(
      exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock, onRetryableFailure })
    ).rejects.toThrow('still down');

    const first = onRetryableFailure.mock.calls[0]?.[0];
    if (!first) {
      throw new Error('Expected the retryable failure');
    }
    // The retry swallows the rethrow so callers never see an unhandled
    // rejection; a repeated failure arrives through the callback again.
    await first.retry();

    expect(exit).toHaveBeenCalledTimes(2);
    expect(onRetryableFailure).toHaveBeenCalledTimes(2);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(lock.current).toBe(false);
  });

  it('clears the host surface when a retry turns non-retryable', async () => {
    const { onAccepted, router, lock } = createHarness();
    const exit = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(
        new Error('Remote session exit is not supported for the current session')
      );
    const onRetryableFailure = vi.fn<(failure: RetryableExitFailure) => void>();
    const onNonRetryableFailure = vi.fn<() => void>();

    await expect(
      exitRemoteSessionWithFeedback({
        exit,
        onAccepted,
        router,
        lock,
        onRetryableFailure,
        onNonRetryableFailure,
      })
    ).rejects.toThrow('connection reset');

    expect(onRetryableFailure).toHaveBeenCalledTimes(1);
    expect(onNonRetryableFailure).not.toHaveBeenCalled();

    const failure = onRetryableFailure.mock.calls[0]?.[0];
    if (!failure) {
      throw new Error('Expected the retryable failure');
    }
    await failure.retry();

    expect(exit).toHaveBeenCalledTimes(2);
    // A permanent failure must release the durable surface instead of leaving
    // a stale message and a retry button that can never succeed.
    expect(onNonRetryableFailure).toHaveBeenCalledTimes(1);
    expect(onRetryableFailure).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      'Remote session exit is not supported for the current session'
    );
    expect(onAccepted).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(lock.current).toBe(false);
  });
});

describe('exitRemoteSessionWithFeedback — non-retryable error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'Remote session exit is not supported for the current session',
    'Remote session exit is unavailable for the current session',
    'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
  ])('shows "%s" with no CTA and does not navigate', async message => {
    const { onAccepted, router, lock } = createHarness();
    const exit = vi.fn(async () => {
      await Promise.resolve();
      throw new Error(message);
    });

    await expect(exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock })).rejects.toThrow(
      message
    );

    expect(exit).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(message);
    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    expect(options?.action).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(lock.current).toBe(false);
  });
});

describe('exitRemoteSessionWithFeedback — retry lock integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the retry through settleVoiceInputBeforeSubmit with the provided lock', async () => {
    const { onAccepted, router, lock } = createHarness();
    const exit = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('connection reset');
    });

    await expect(exitRemoteSessionWithFeedback({ exit, onAccepted, router, lock })).rejects.toThrow(
      'connection reset'
    );

    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    if (!options?.action || typeof options.action !== 'object' || !('onClick' in options.action)) {
      throw new Error('Expected retry action on the toast');
    }

    options.action.onClick();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(2);
    });

    // The lock state must be released after the retry settles.
    expect(lock.current).toBe(false);
  });
});
