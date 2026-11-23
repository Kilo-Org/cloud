import { act, createElement, useEffect } from 'react';
import {
  type ReconnectHandoff,
  type ReconnectHandoffInput,
} from '@/lib/pr-review/use-reconnect-handoff';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { useReconnectHandoff } from './use-reconnect-handoff';

/**
 * The hand-off every PR-review surface shares, mounted, because what is under
 * test is the provider branch and the attempt the cancel belongs to: a mint, a
 * browser launch, and a retry that supersedes the attempt before it.
 */

type LaunchHandlers = {
  signal?: AbortSignal;
  onReturn: () => Promise<void>;
  onOpenFailure: () => void;
};

const mocks = vi.hoisted(() => ({
  launch: vi.fn<(url: string, handlers: LaunchHandlers) => Promise<void>>(),
  handoff: vi.fn<(target: unknown) => Promise<string>>(),
  connectAuthorization: vi.fn<() => Promise<{ authorizationUrl: string }>>(),
  toastError: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The app's i18n singleton registers this plugin on load.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    useEffect(effect, [effect]);
  },
}));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  launchConnectGateBrowser: mocks.launch,
}));
vi.mock('@/lib/app-shell-handoff', () => ({ appShellHandoffUrl: mocks.handoff }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      connectUserAuthorization: {
        mutationOptions: () => ({ mutationFn: mocks.connectAuthorization }),
      },
    },
  }),
}));

let handoff: ReconnectHandoff | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  handoff = undefined;
  mocks.connectAuthorization.mockResolvedValue({
    authorizationUrl: 'https://github.example/authorize',
  });
  mocks.handoff.mockResolvedValue('https://web.example/app-shell/handoff?token=hook');
  mocks.launch.mockResolvedValue(undefined);
});

async function mount(input: ReconnectHandoffInput): Promise<ReconnectHandoff> {
  function Harness() {
    handoff = useReconnectHandoff(input);
    return null;
  }
  const mounted = await renderWithProviders(createElement(Harness));
  onTestFinished(mounted.unmount);
  return {
    get busy() {
      return handoff?.busy === true;
    },
    reconnect: () => {
      if (!handoff) {
        throw new Error('the handoff hook did not mount');
      }
      handoff.reconnect();
    },
  };
}

describe('useReconnectHandoff', () => {
  it('mints the GitHub authorization and opens it', async () => {
    const onReturn = vi.fn<() => void>();
    const pending = Promise.withResolvers<undefined>();
    mocks.launch.mockImplementation(() => pending.promise);
    const hook = await mount({ platform: 'github', organizationId: null, onReturn });

    act(() => {
      hook.reconnect();
    });
    await waitFor(() => mocks.launch.mock.calls.length === 1);

    const handlers = mocks.launch.mock.calls[0]?.[1];
    expect(mocks.connectAuthorization).toHaveBeenCalledOnce();
    expect(mocks.launch.mock.calls[0]?.[0]).toBe('https://github.example/authorize');
    // The press stays busy while the browser is open, so a second press cannot
    // start beside it.
    expect(handlers?.signal?.aborted).toBe(false);
    expect(hook.busy).toBe(true);

    // The browser closing is the surface's own refresh edge; the hook only
    // passes it through.
    await act(async () => {
      await handlers?.onReturn();
      pending.resolve(undefined);
    });
    expect(onReturn).toHaveBeenCalledOnce();
    await waitFor(() => !hook.busy);
  });

  it('mints the organization GitLab page and opens it', async () => {
    const hook = await mount({ platform: 'gitlab', organizationId: 'org_1' });

    act(() => {
      hook.reconnect();
    });
    await waitFor(() => mocks.launch.mock.calls.length === 1);

    expect(mocks.handoff).toHaveBeenCalledWith({
      page: 'integration',
      platform: 'gitlab',
      organizationId: 'org_1',
    });
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(
      'https://web.example/app-shell/handoff?token=hook'
    );
    expect(mocks.connectAuthorization).not.toHaveBeenCalled();
  });

  it('mints the personal GitLab page with no organization', async () => {
    const hook = await mount({ platform: 'gitlab', organizationId: null });

    act(() => {
      hook.reconnect();
    });
    await waitFor(() => mocks.launch.mock.calls.length === 1);

    // The server binds a personal flow to the caller's own token, so the target
    // carries no organization at all.
    expect(mocks.handoff).toHaveBeenCalledWith({ page: 'integration', platform: 'gitlab' });
  });

  it('reports a failed GitLab mint as a browser that could not open', async () => {
    mocks.handoff.mockRejectedValue(new Error('mint failed'));
    const hook = await mount({ platform: 'gitlab', organizationId: 'org_1' });

    act(() => {
      hook.reconnect();
    });
    await waitFor(() => mocks.toastError.mock.calls.length === 1);

    // Nothing reached the browser, so the launcher reported nothing; the hook
    // owns this one failure.
    expect(mocks.toastError).toHaveBeenCalledWith('authErrors.couldNotOpenBrowser');
    expect(mocks.launch).not.toHaveBeenCalled();
    await waitFor(() => !hook.busy);
  });

  it('aborts the attempt still waiting when the reader presses again', async () => {
    const launches: { signal?: AbortSignal; resolve: () => void }[] = [];
    mocks.launch.mockImplementation((_url, handlers) => {
      const pending = Promise.withResolvers<undefined>();
      launches.push({
        signal: handlers.signal,
        resolve: () => {
          pending.resolve(undefined);
        },
      });
      return pending.promise;
    });
    const hook = await mount({ platform: 'github', organizationId: null });

    act(() => {
      hook.reconnect();
    });
    await waitFor(() => launches.length === 1);

    act(() => {
      hook.reconnect();
    });
    await waitFor(() => launches.length === 2);

    // The first attempt's signal is the one the browser wait holds, so aborting
    // it is what stops that wait reporting for a press the reader abandoned.
    expect(launches[0]?.signal?.aborted).toBe(true);
    expect(launches[1]?.signal?.aborted).toBe(false);

    launches[0]?.resolve();
    launches[1]?.resolve();
    await waitFor(() => !hook.busy);
  });

  it('pushes the Bitbucket connect sheet for an organization', async () => {
    const hook = await mount({ platform: 'bitbucket', organizationId: 'org_1' });

    act(() => {
      hook.reconnect();
    });

    // The sheet's own invalidation is what clears the surface, so nothing waits
    // on a browser round trip.
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(app)/bitbucket-connect',
      params: { scope: 'org_1' },
    });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(hook.busy).toBe(false);
  });

  it('leaves a personal Bitbucket scope alone', async () => {
    const hook = await mount({ platform: 'bitbucket', organizationId: null });

    act(() => {
      hook.reconnect();
    });

    // Cloud has no personal review connection, so there is no sheet to open.
    expect(router.push).not.toHaveBeenCalled();
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
