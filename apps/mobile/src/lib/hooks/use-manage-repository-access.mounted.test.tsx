// The picker's Manage access control is the only way to widen what the
// repository list may show, so a tap that produces nothing is the whole defect:
// it has to draw a busy state while the install state is minted, never start a
// second launch from a repeated tap, and report a launch that failed — including
// one that failed after the app's own return edge ended the wait.

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  type ManageRepositoryAccess,
  useManageRepositoryAccess,
} from './use-manage-repository-access';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  mintInstallState: vi.fn((_input: unknown): Promise<{ token: string }> =>
    Promise.resolve({ token: 'install-token' })
  ),
  launch: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  isPersonal: (scope: string) => scope === 'personal',
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));

vi.mock('@/lib/agent-github-integration', () => ({
  getGitHubIntegrationUrl: (base: string, orgId: string | undefined, token?: string) =>
    `${base}/${orgId ?? 'personal'}${token ? `?state=${token}` : ''}`,
}));

vi.mock('@/lib/integration-urls', () => ({
  getGitLabIntegrationUrl: (base: string, orgId: string | undefined) =>
    `${base}/${orgId ?? 'personal'}/gitlab`,
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { githubApps: { mintInstallState: { mutate: mocks.mintInstallState } } },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    addEventListener: () => ({ remove: () => undefined }),
    currentState: 'active',
  },
}));

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  WebBrowserResultType: { OPENED: 'opened', CANCEL: 'cancel', DISMISS: 'dismiss' },
}));

// Only the launch is faked: the late-failure report under test is the real one.
vi.mock('@/lib/pr-review/connect-gate-platform', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openAuthorizationAndWaitForReturn: mocks.launch,
}));

type HookResult = ManageRepositoryAccess | undefined;

type Handlers = { onOpen?: () => void; onReturn?: () => void };

function Harness({
  scope,
  platform,
  handlers,
  resultRef,
}: {
  scope: string;
  platform: 'github' | 'gitlab' | 'bitbucket';
  handlers: Handlers;
  resultRef: { current: HookResult };
}) {
  resultRef.current = useManageRepositoryAccess(scope, platform, handlers);
  return null;
}

function mountHook(
  scope: string,
  platform: 'github' | 'gitlab' | 'bitbucket',
  handlers: Handlers = {}
): { current: HookResult } {
  const resultRef: { current: HookResult } = { current: undefined };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { scope, platform, handlers, resultRef }));
  });
  return resultRef;
}

function requireHook(resultRef: { current: HookResult }): ManageRepositoryAccess {
  const result = resultRef.current;
  if (!result) {
    throw new Error('useManageRepositoryAccess returned no action');
  }
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mintInstallState.mockImplementation(() => Promise.resolve({ token: 'install-token' }));
  mocks.launch.mockImplementation(() =>
    Promise.resolve({ reported: Promise.resolve({ type: 'dismiss' }), settledByLaunch: true })
  );
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
    const onReturn = vi.fn<() => void>();
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
      expect(onReturn).toHaveBeenCalledOnce();
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
    const onReturn = vi.fn<() => void>();
    const resultRef = mountHook('personal', 'github', { onReturn });

    await act(() => {
      requireHook(resultRef).handlePress();
    });

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('common.couldNotOpen');
    });
    // The caller still resyncs: the page may have been changed earlier.
    expect(onReturn).toHaveBeenCalledOnce();
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
});
