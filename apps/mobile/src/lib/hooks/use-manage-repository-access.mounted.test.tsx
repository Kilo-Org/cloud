// The Manage-access control's busy state, its mint failures, and the return edge
// its caller resyncs from. Mocks and mounting live in the helpers module, whose
// import MUST stay first: it registers the module mocks while it is evaluated.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';

import {
  accessMocks,
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
    expect(mocks.mintInstallState).toHaveBeenCalledTimes(1);
    expect(mocks.launch).toHaveBeenCalledWith(
      'https://app.example.com/personal?state=install-token'
    );

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
      expect(mocks.mintInstallState).toHaveBeenCalledTimes(2);
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

    expect(mocks.mintInstallState).toHaveBeenCalledTimes(1);
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
    mocks.mintInstallState.mockRejectedValue(new Error('mint failed'));
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

  // An organization's mint is narrower than the screens that offer this
  // control: a member is refused with UNAUTHORIZED, and an installation that
  // cannot take another one with FORBIDDEN. Neither can mint a token, and the
  // page works without one — so the tap opens it rather than answering nothing
  // in the one state that needs a route to it.
  for (const code of ['UNAUTHORIZED', 'FORBIDDEN']) {
    it(`opens the settings page without a token when the organization's mint is refused with ${code}`, async () => {
      mocks.mintInstallState.mockRejectedValue({ data: { code } });
      const onReturn = vi.fn<(opened: boolean) => void>();
      const resultRef = mountHook('org_123', 'github', { onReturn });

      await act(() => {
        requireHook(resultRef).handlePress();
      });

      await vi.waitFor(() => {
        expect(onReturn).toHaveBeenCalledWith(true);
      });
      expect(mocks.launch).toHaveBeenCalledWith('https://app.example.com/org_123');
      expect(mocks.toastError).not.toHaveBeenCalled();
    });
  }

  // A caller that can present refusals itself takes the role's answer instead of
  // the page: nothing opens, the list is not resynced, and no error is toasted —
  // the caller renders the refusal in the control's place.
  it('hands a role refusal to the caller and opens nothing', async () => {
    mocks.mintInstallState.mockRejectedValue(
      Object.assign(new Error('mint refused'), { data: { code: 'UNAUTHORIZED' } })
    );
    const onRoleRefused = vi.fn<() => void>();
    const onReturn = vi.fn<(opened: boolean) => void>();
    const resultRef = mountHook('org_123', 'github', { onReturn, onRoleRefused });

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(onRoleRefused).toHaveBeenCalledTimes(1);
    });
    expect(onReturn).toHaveBeenCalledWith(false);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(requireHook(resultRef).pending).toBe(false);
  });

  // The single-installation guard and a lost session are not the role answer:
  // the plain settings page mints its own state for the signed-in user, so the
  // caller that presents refusals still hands the reader to it for these.
  for (const failure of [
    {
      name: 'an organization that already holds an installation',
      error: { data: { code: 'FORBIDDEN' } },
    },
    {
      name: 'a missing or invalid session',
      error: Object.assign(new Error('session expired'), {
        data: { code: 'UNAUTHORIZED', authRequired: true },
      }),
    },
  ]) {
    it(`keeps the settings-page fallback for ${failure.name}`, async () => {
      mocks.mintInstallState.mockRejectedValue(failure.error);
      const onRoleRefused = vi.fn<() => void>();
      const onReturn = vi.fn<(opened: boolean) => void>();
      const resultRef = mountHook('org_123', 'github', { onReturn, onRoleRefused });

      await act(() => {
        requireHook(resultRef).handlePress();
      });

      await vi.waitFor(() => {
        expect(onReturn).toHaveBeenCalledWith(true);
      });
      expect(onRoleRefused).not.toHaveBeenCalled();
      expect(mocks.launch).toHaveBeenCalledWith('https://app.example.com/org_123');
      expect(mocks.toastError).not.toHaveBeenCalled();
    });
  }

  // A caller without the handler keeps the page fallback for a role refusal:
  // nothing there names the refusal, and the page is the route the control has.
  it('keeps the settings-page fallback for a role refusal without the handler', async () => {
    mocks.mintInstallState.mockRejectedValue(
      Object.assign(new Error('mint refused'), { data: { code: 'UNAUTHORIZED' } })
    );
    const onReturn = vi.fn<(opened: boolean) => void>();
    const resultRef = mountHook('org_123', 'github', { onReturn });

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(onReturn).toHaveBeenCalledWith(true);
    });
    expect(mocks.launch).toHaveBeenCalledWith('https://app.example.com/org_123');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  // A personal scope has no page-level fallback to reach: the page mints its
  // own state for a signed-in user, and a personal mint failure still has to be
  // reported.
  it('still reports a refused personal mint', async () => {
    mocks.mintInstallState.mockRejectedValue({ data: { code: 'UNAUTHORIZED' } });
    const resultRef = mountHook('personal', 'github');

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('prReview.couldNotOpenGitHubAppSettings');
    });
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
