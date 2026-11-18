// The Manage-access control's busy state, its mint failures, and the return edge
// its caller resyncs from. Mocks and mounting live in the helpers module, whose
// import MUST stay first: it registers the module mocks while it is evaluated.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';

import {
  accessMocks,
  HANDOFF_URL,
  mountHook,
  requireHook,
  resetAccessMocks,
} from './use-manage-repository-access.test-helpers';

const mocks = accessMocks();

beforeEach(() => {
  resetAccessMocks();
});

describe('useManageRepositoryAccess', () => {
  it('has no action for Bitbucket, which has no settings page', () => {
    const resultRef = mountHook('personal', 'bitbucket');
    expect(resultRef.current).toBeUndefined();
  });

  it('stays busy from the tap until the browser wait settles', async () => {
    const pendingLaunch = Promise.withResolvers<unknown>();
    mocks.launch.mockReturnValue(pendingLaunch.promise);
    const onOpen = vi.fn<() => void>();
    const onReturn = vi.fn<(opened: boolean) => void>();
    const resultRef = mountHook('personal', 'github', { onOpen, onReturn });
    expect(requireHook(resultRef).pending).toBe(false);

    await act(async () => {
      requireHook(resultRef).handlePress();
      await Promise.resolve();
    });
    // The busy state and the caller's signal are up before anything resolves,
    // so the tap is never inert.
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onReturn).not.toHaveBeenCalled();
    expect(mocks.handoffUrl).toHaveBeenCalledTimes(1);
    expect(mocks.handoffUrl).toHaveBeenCalledWith({ page: 'github-app' });
    expect(mocks.launch).toHaveBeenCalledWith(HANDOFF_URL);

    await act(async () => {
      pendingLaunch.resolve({
        reported: Promise.resolve({ type: 'dismiss' }),
        settledByLaunch: true,
      });
      await pendingLaunch.promise;
    });
    await vi.waitFor(() => {
      expect(onReturn).toHaveBeenCalledWith(true);
    });
    expect(requireHook(resultRef).pending).toBe(false);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('is busy while the launch is pending', async () => {
    const pendingLaunch = Promise.withResolvers<unknown>();
    mocks.launch.mockReturnValue(pendingLaunch.promise);
    const resultRef = mountHook('personal', 'github');

    await act(async () => {
      requireHook(resultRef).handlePress();
      await Promise.resolve();
    });
    expect(requireHook(resultRef).pending).toBe(true);

    await act(async () => {
      pendingLaunch.resolve({
        reported: Promise.resolve({ type: 'dismiss' }),
        settledByLaunch: true,
      });
      await pendingLaunch.promise;
    });
    await vi.waitFor(() => {
      expect(requireHook(resultRef).pending).toBe(false);
    });
  });

  it('returns to idle when the browser report never arrives', async () => {
    vi.useFakeTimers();
    try {
      const pendingLaunch = Promise.withResolvers<unknown>();
      mocks.launch.mockReturnValue(pendingLaunch.promise);
      const resultRef = mountHook('personal', 'github');

      await act(async () => {
        requireHook(resultRef).handlePress();
        await Promise.resolve();
      });
      expect(requireHook(resultRef).pending).toBe(true);

      // A platform that drops the browser's report cannot leave the control
      // disabled on the user's screen.
      await act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(requireHook(resultRef).pending).toBe(false);
      expect(mocks.toastError).not.toHaveBeenCalled();

      // And it is genuinely usable again, not just painted that way.
      await act(async () => {
        requireHook(resultRef).handlePress();
        await Promise.resolve();
      });
      expect(mocks.handoffUrl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a newer attempt busy when an older one settles', async () => {
    vi.useFakeTimers();
    try {
      const firstLaunch = Promise.withResolvers<unknown>();
      const secondLaunch = Promise.withResolvers<unknown>();
      mocks.launch
        .mockReturnValueOnce(firstLaunch.promise)
        .mockReturnValueOnce(secondLaunch.promise);
      const resultRef = mountHook('personal', 'github');

      await act(async () => {
        requireHook(resultRef).handlePress();
        await Promise.resolve();
      });
      await act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(requireHook(resultRef).pending).toBe(false);

      // The control is offered again while the first wait is still open.
      await act(async () => {
        requireHook(resultRef).handlePress();
        await Promise.resolve();
      });
      expect(requireHook(resultRef).pending).toBe(true);

      // The superseded attempt settling must not clear the new one's state.
      await act(async () => {
        firstLaunch.resolve({
          reported: Promise.resolve({ type: 'dismiss' }),
          settledByLaunch: true,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requireHook(resultRef).pending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts no second launch from a repeated tap while a launch is pending', async () => {
    const pendingLaunch = Promise.withResolvers<unknown>();
    mocks.launch.mockReturnValue(pendingLaunch.promise);
    const resultRef = mountHook('personal', 'github');

    await act(async () => {
      requireHook(resultRef).handlePress();
      requireHook(resultRef).handlePress();
      requireHook(resultRef).handlePress();
      await Promise.resolve();
    });

    expect(mocks.handoffUrl).toHaveBeenCalledTimes(1);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it('reports a launch that never opened', async () => {
    mocks.launch.mockRejectedValue(new Error('no browser'));
    const onReturn = vi.fn<(opened: boolean) => void>();
    const resultRef = mountHook('personal', 'github', { onReturn });

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('common.couldNotOpen');
    });
    // The caller still resyncs: the page may have been changed earlier. It is
    // told the page never opened, so a fix-in-place surface can keep it up.
    expect(onReturn).toHaveBeenCalledWith(false);
  });

  it('reports a launch that failed after the foreground edge ended the wait', async () => {
    // The wait ended on the app's own return edge; the browser's report arrives
    // afterwards and says the launch never opened anything.
    mocks.launch.mockResolvedValue({
      reported: Promise.resolve(undefined),
      settledByLaunch: false,
    });
    const resultRef = mountHook('personal', 'github');

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('common.couldNotOpen');
    });
  });

  it('reports a failed mint instead of leaving the tap unanswered', async () => {
    mocks.handoffUrl.mockRejectedValue(new Error('mint failed'));
    const resultRef = mountHook('personal', 'github');

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('prReview.couldNotOpenGitHubAppSettings');
    });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(requireHook(resultRef).pending).toBe(false);
  });

  it('names the organization on the GitHub hand-off target', async () => {
    const onReturn = vi.fn<(opened: boolean) => void>();
    const resultRef = mountHook('org_123', 'github', { onReturn });

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(onReturn).toHaveBeenCalledWith(true);
    });
    expect(mocks.handoffUrl).toHaveBeenCalledWith({
      page: 'github-app',
      organizationId: 'org_123',
    });
    expect(mocks.launch).toHaveBeenCalledWith(HANDOFF_URL);
  });

  it('hands off to the GitLab integration shell page for a personal scope', async () => {
    const onReturn = vi.fn<(opened: boolean) => void>();
    const resultRef = mountHook('personal', 'gitlab', { onReturn });

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(onReturn).toHaveBeenCalledWith(true);
    });
    expect(mocks.handoffUrl).toHaveBeenCalledWith({ page: 'integration', platform: 'gitlab' });
    expect(mocks.launch).toHaveBeenCalledWith(HANDOFF_URL);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('reports a failed GitLab mint instead of leaving the tap unanswered', async () => {
    mocks.handoffUrl.mockRejectedValue(new Error('mint failed'));
    const onReturn = vi.fn<(opened: boolean) => void>();
    const resultRef = mountHook('personal', 'gitlab', { onReturn });

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('common.couldNotOpen');
    });
    expect(onReturn).toHaveBeenCalledWith(false);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
