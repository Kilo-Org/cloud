// The hub's Connect control hands the browser the app-shell page that owns a
// provider's connect flow, reached through a one-time hand-off token. The mint
// is the only step that can fail, and its failure is the tap's failure: the row
// reports it instead of opening a page that would refuse the reader again.
// Bitbucket has no shell page, so its row keeps the full web page it opened
// before.

import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type IntegrationProvider } from '@/lib/integrations/provider-catalog';

import { type IntegrationConnect, useIntegrationConnect } from './use-integrations';

const HANDOFF_URL = 'https://app.example.com/app-shell/handoff?token=handoff-token';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  handoffUrl: vi.fn((_target: unknown): Promise<string> => Promise.resolve(HANDOFF_URL)),
  launch: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: mocks.toastError, success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/app-shell-handoff', () => ({ appShellHandoffUrl: mocks.handoffUrl }));

// `use-integrations` also owns the provider reads and disconnects, which build
// their queries and call the uninstall procedures; this suite drives only the
// connect tap, so the client is never reached.
vi.mock('@/lib/trpc', () => ({ trpcClient: {}, useTRPC: () => ({}) }));

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
  mocks.handoffUrl.mockImplementation(() => Promise.resolve(HANDOFF_URL));
  mocks.launch.mockImplementation(() =>
    Promise.resolve({ reported: Promise.resolve({ type: 'dismiss' }), settledByLaunch: true })
  );
});

describe('useIntegrationConnect', () => {
  it('opens the GitHub App shell page for an organization', async () => {
    const onReturned = vi.fn(() => Promise.resolve());
    const resultRef = mountHook('org_1', onReturned);

    await connect(resultRef, 'github');

    expect(mocks.handoffUrl).toHaveBeenCalledWith({
      page: 'github-app',
      organizationId: 'org_1',
    });
    expect(mocks.launch).toHaveBeenCalledWith(HANDOFF_URL);
    expect(onReturned).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('opens the provider integration shell page', async () => {
    const onReturned = vi.fn(() => Promise.resolve());
    const resultRef = mountHook(undefined, onReturned);

    await connect(resultRef, 'slack');

    expect(mocks.handoffUrl).toHaveBeenCalledWith({ page: 'integration', platform: 'slack' });
    expect(mocks.launch).toHaveBeenCalledWith(HANDOFF_URL);
    expect(onReturned).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('opens the organization integration shell page', async () => {
    const resultRef = mountHook('org_1');

    await connect(resultRef, 'gitlab');

    expect(mocks.handoffUrl).toHaveBeenCalledWith({
      page: 'integration',
      platform: 'gitlab',
      organizationId: 'org_1',
    });
    expect(mocks.launch).toHaveBeenCalledWith(HANDOFF_URL);
  });

  // Bitbucket has no shell page, so its row keeps the full web page.
  it('keeps the full web page for Bitbucket', async () => {
    const resultRef = mountHook('org_1');

    await connect(resultRef, 'bitbucket');

    expect(mocks.handoffUrl).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledWith(
      'https://app.example.com/organizations/org_1/integrations/bitbucket'
    );
  });

  it('reports a failed mint and opens nothing', async () => {
    mocks.handoffUrl.mockRejectedValueOnce(new Error('handoff failed'));
    const onReturned = vi.fn(() => Promise.resolve());
    const resultRef = mountHook('org_1', onReturned);

    await connect(resultRef, 'github');

    expect(mocks.toastError).toHaveBeenCalledWith('integrations.connectFailed');
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(onReturned).not.toHaveBeenCalled();
    expect(requireHook(resultRef).pendingProvider).toBeNull();
  });

  it('targets the personal scope without an organizationId', () => {
    mountHook(undefined);

    expect(mocks.handoffUrl).not.toHaveBeenCalled();
  });
});
