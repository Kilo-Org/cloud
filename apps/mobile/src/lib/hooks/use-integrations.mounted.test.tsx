// The hub's Connect control hands the browser the web page that owns a
// provider's connect flow. GitHub's page takes a one-time install state token,
// and an organization that cannot mint one — a member without `OWNER`/`ADMIN`,
// or an organization that already holds an installation — must still reach that
// page, which mints its own state for the signed-in web user. Any other failure
// is still reported, so a personal refusal never opens a page that will refuse
// the reader again.

import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type IntegrationProvider } from '@/lib/integrations/provider-catalog';

import { type IntegrationConnect, useIntegrationConnect } from './use-integrations';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  mintInstallState: vi.fn((_input: unknown): Promise<{ token: string }> =>
    Promise.resolve({ token: 'install-token' })
  ),
  launch: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: mocks.toastError, success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { githubApps: { mintInstallState: { mutate: mocks.mintInstallState } } },
  useTRPC: () => ({}),
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

type HookResult = IntegrationConnect | undefined;

function Harness({
  organizationId,
  onReturned,
  resultRef,
}: {
  organizationId: string | undefined;
  onReturned: () => Promise<void>;
  resultRef: { current: HookResult };
}) {
  resultRef.current = useIntegrationConnect({ organizationId, onReturned });
  return null;
}

function mountHook(
  organizationId: string | undefined,
  onReturned: () => Promise<void> = () => Promise.resolve()
): { current: HookResult } {
  const resultRef: { current: HookResult } = { current: undefined };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { organizationId, onReturned, resultRef }));
  });
  return resultRef;
}

function requireHook(resultRef: { current: HookResult }): IntegrationConnect {
  const result = resultRef.current;
  if (!result) {
    throw new Error('useIntegrationConnect returned no action');
  }
  return result;
}

async function connect(resultRef: { current: HookResult }, provider: IntegrationProvider) {
  await act(async () => {
    await requireHook(resultRef).connect(provider);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mintInstallState.mockImplementation(() => Promise.resolve({ token: 'install-token' }));
  mocks.launch.mockImplementation(() =>
    Promise.resolve({ reported: Promise.resolve({ type: 'dismiss' }), settledByLaunch: true })
  );
});

describe('useIntegrationConnect', () => {
  it('opens the GitHub App page with the minted install state for an organization', async () => {
    const onReturned = vi.fn(() => Promise.resolve());
    const resultRef = mountHook('org_1', onReturned);

    await connect(resultRef, 'github');

    expect(mocks.mintInstallState).toHaveBeenCalledWith({
      organizationId: 'org_1',
      returnTo: '/organizations/org_1/integrations/github',
    });
    expect(mocks.launch).toHaveBeenCalledWith(
      'https://app.example.com/github-app?organizationId=org_1&installState=install-token&fromApp=1'
    );
    expect(onReturned).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  // An organization's mint is narrower than the surfaces that offer Connect: a
  // member is refused with UNAUTHORIZED, and an installation that cannot take
  // another one with FORBIDDEN. Neither can mint a token, and the page works
  // without one — so the tap opens it and still waits for the return.
  for (const code of ['FORBIDDEN', 'UNAUTHORIZED']) {
    it(`opens the tokenless GitHub App page when the organization's mint is refused with ${code}`, async () => {
      mocks.mintInstallState.mockRejectedValueOnce({ data: { code } });
      const onReturned = vi.fn(() => Promise.resolve());
      const resultRef = mountHook('org_1', onReturned);

      await connect(resultRef, 'github');

      expect(mocks.launch).toHaveBeenCalledWith(
        'https://app.example.com/github-app?organizationId=org_1'
      );
      expect(onReturned).toHaveBeenCalledOnce();
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(requireHook(resultRef).pendingProvider).toBeNull();
    });
  }

  it('reports a mint failure that is neither a permission nor an installation refusal', async () => {
    mocks.mintInstallState.mockRejectedValueOnce({ data: { code: 'INTERNAL_SERVER_ERROR' } });
    const onReturned = vi.fn(() => Promise.resolve());
    const resultRef = mountHook('org_1', onReturned);

    await connect(resultRef, 'github');

    expect(mocks.toastError).toHaveBeenCalledWith('integrations.connectFailed');
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(onReturned).not.toHaveBeenCalled();
    expect(requireHook(resultRef).pendingProvider).toBeNull();
  });

  // A personal scope has no page-level fallback to reach: the page mints its
  // own state only for a signed-in web user, and a refused personal mint still
  // has to be reported.
  it('still reports a refused personal mint', async () => {
    mocks.mintInstallState.mockRejectedValueOnce({ data: { code: 'FORBIDDEN' } });
    const resultRef = mountHook(undefined);

    await connect(resultRef, 'github');

    expect(mocks.toastError).toHaveBeenCalledWith('integrations.connectFailed');
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('never mints an install state for a provider without one', async () => {
    const onReturned = vi.fn(() => Promise.resolve());
    const resultRef = mountHook(undefined, onReturned);

    await connect(resultRef, 'slack');

    expect(mocks.mintInstallState).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledWith('https://app.example.com/integrations/slack');
    expect(onReturned).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
