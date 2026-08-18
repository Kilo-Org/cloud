/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { type DeleteAccountPhase, useDeleteAccount } from './use-delete-account';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const challengeFn = vi.hoisted(() => vi.fn());
const executeFn = vi.hoisted(() => vi.fn());
const signOutFn = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      requestAccountDeletionChallenge: {
        mutationOptions: (opts: object) => ({
          ...opts,
          mutationFn: challengeFn,
          mutationKey: ['delete-account-challenge'],
        }),
      },
      requestAccountDeletion: {
        mutationOptions: (opts: object) => ({
          ...opts,
          mutationFn: executeFn,
          mutationKey: ['delete-account-execute'],
        }),
      },
    },
  }),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ signOut: signOutFn }),
}));

vi.mock('sonner-native', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

type DeleteAccountResult = {
  phase: DeleteAccountPhase;
  isPending: boolean;
  devCode: string | null;
  beginDelete: () => void;
  submitCode: () => void;
  setCode: (code: string) => void;
};

function Probe({ holder }: { holder: { current: DeleteAccountResult | null } }) {
  holder.current = useDeleteAccount();
  return null;
}

async function mountProbe(): Promise<{ current: DeleteAccountResult | null }> {
  const holder: { current: DeleteAccountResult | null } = { current: null };
  await renderWithProviders(createElement(Probe, { holder }));
  return holder;
}

function current(holder: { current: DeleteAccountResult | null }): DeleteAccountResult {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const state: { resolve: ((value: T) => void) | undefined } = { resolve: undefined };
  const promise = new Promise<T>(resolve => {
    state.resolve = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      state.resolve?.(value);
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useDeleteAccount', () => {
  beforeEach(() => {
    vi.stubGlobal('__DEV__', false);
    challengeFn.mockReset();
    executeFn.mockReset();
    signOutFn.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('happy: challenge then valid code deletes and signs out', async () => {
    challengeFn.mockResolvedValue({ challengeId: 'challenge-1', devCode: '123456' });
    executeFn.mockResolvedValue({ status: 'deleted' });

    const holder = await mountProbe();

    act(() => {
      current(holder).beginDelete();
    });
    await waitFor(() => current(holder).phase === 'awaiting-code');

    act(() => {
      current(holder).setCode('123456');
      current(holder).submitCode();
    });
    await waitFor(() => current(holder).phase === 'deleted');

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn.mock.calls[0]?.[0]).toEqual({ challengeId: 'challenge-1', code: '123456' });
    expect(toastSuccess).toHaveBeenCalledWith('Your account has been deleted.');
    expect(signOutFn).toHaveBeenCalledWith(true);
  });

  it('retryable: a failed challenge toasts and stays retryable', async () => {
    challengeFn.mockRejectedValue(new Error('Network error'));

    const holder = await mountProbe();

    act(() => {
      current(holder).beginDelete();
    });
    await waitFor(() => toastError.mock.calls.length > 0);

    expect(toastError).toHaveBeenCalledWith('Network error');
    expect(signOutFn).not.toHaveBeenCalled();
    // Back to idle: the caller can re-request a code (retry / resend).
    expect(current(holder).phase).toBe('idle');
  });

  it('retryable: an execute network failure keeps the challenge', async () => {
    challengeFn.mockResolvedValue({ challengeId: 'challenge-1' });
    executeFn.mockRejectedValue(new Error('Network error'));

    const holder = await mountProbe();

    act(() => {
      current(holder).beginDelete();
    });
    await waitFor(() => current(holder).phase === 'awaiting-code');

    act(() => {
      current(holder).setCode('123456');
      current(holder).submitCode();
    });
    await waitFor(() => toastError.mock.calls.length > 0);

    expect(toastError).toHaveBeenCalledWith('Network error');
    expect(signOutFn).not.toHaveBeenCalled();
    // Challenge kept: the user can resubmit the same code.
    expect(current(holder).phase).toBe('awaiting-code');
  });

  it('non-retryable: a precondition failure keeps the challenge so the user can resubmit', async () => {
    challengeFn.mockResolvedValue({ challengeId: 'challenge-1' });
    executeFn.mockRejectedValue({
      data: { code: 'PRECONDITION_FAILED' },
      message: 'Cancel the subscription before deleting the account.',
    });

    const holder = await mountProbe();

    act(() => {
      current(holder).beginDelete();
    });
    await waitFor(() => current(holder).phase === 'awaiting-code');

    act(() => {
      current(holder).setCode('654321');
      current(holder).submitCode();
    });
    await waitFor(() => toastError.mock.calls.length > 0);

    expect(toastError).toHaveBeenCalledWith('Cancel the subscription before deleting the account.');
    expect(signOutFn).not.toHaveBeenCalled();
    // Challenge kept: the user can fix the blocker and resubmit the same code.
    expect(current(holder).phase).toBe('awaiting-code');
  });

  it('non-retryable: an invalid code keeps the challenge so the user can re-enter', async () => {
    challengeFn.mockResolvedValue({ challengeId: 'challenge-1' });
    executeFn.mockRejectedValue({
      data: { code: 'UNAUTHORIZED' },
      message: 'Invalid confirmation code',
    });

    const holder = await mountProbe();

    act(() => {
      current(holder).beginDelete();
    });
    await waitFor(() => current(holder).phase === 'awaiting-code');

    act(() => {
      current(holder).setCode('000000');
      current(holder).submitCode();
    });
    await waitFor(() => toastError.mock.calls.length > 0);

    expect(toastError).toHaveBeenCalledWith('Invalid confirmation code');
    expect(signOutFn).not.toHaveBeenCalled();
    // Challenge kept: the user can re-enter a correct code.
    expect(current(holder).phase).toBe('awaiting-code');
  });

  it('pending: isPending is true while the challenge is in flight', async () => {
    const deferredChallenge = createDeferred<{ challengeId: string }>();
    challengeFn.mockReturnValue(deferredChallenge.promise);

    const holder = await mountProbe();

    act(() => {
      current(holder).beginDelete();
    });

    await waitFor(() => current(holder).isPending);
    expect(current(holder).phase).toBe('requesting');

    act(() => {
      deferredChallenge.resolve({ challengeId: 'challenge-1' });
    });
    await waitFor(() => current(holder).phase === 'awaiting-code');
    expect(current(holder).isPending).toBe(false);
  });
});
