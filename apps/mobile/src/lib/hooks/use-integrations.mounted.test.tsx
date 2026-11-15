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

import {
  type IntegrationConnect,
  useDisconnectIntegration,
  useIntegrationConnect,
} from './use-integrations';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  mintInstallState: vi.fn((_input: unknown): Promise<{ token: string }> =>
    Promise.resolve({ token: 'install-token' })
  ),
  launch: vi.fn<(url: string) => Promise<unknown>>(),
  role: 'member' as string | undefined,
  push: vi.fn<(href: string) => void>(),
  mutation: null as {
    onError?: (
      error: unknown,
      variables: { provider: IntegrationProvider; githubIntegrationId: string | null }
    ) => void;
  } | null,
}));

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));

// Role resolution reads the membership list; only that list and the persisted
// selection are faked, so the real role predicate decides the copy.
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org_1', isLoaded: true }),
}));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({
    data: [{ organizationId: 'org_1', role: mocks.role }],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => {
    mocks.mutation = options as typeof mocks.mutation;
    return { mutate: vi.fn() };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

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
  mocks.role = 'member';
  mocks.mutation = null;
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

  // A filesystem or domain error carries a bare `code` too, and it is not a
  // server verdict: only a real tRPC client error may open the page.
  it('reports a non-tRPC rejection that carries a bare permission code', async () => {
    mocks.mintInstallState.mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'FORBIDDEN' })
    );
    const onReturned = vi.fn(() => Promise.resolve());
    const resultRef = mountHook('org_1', onReturned);

    await connect(resultRef, 'github');

    expect(mocks.toastError).toHaveBeenCalledWith('integrations.connectFailed');
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(onReturned).not.toHaveBeenCalled();
    expect(requireHook(resultRef).pendingProvider).toBeNull();
  });

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

  // The organization subscription gate can refuse the hand-off itself. A role
  // that can change the plan gets the copy that offers the step and the step;
  // everyone else keeps the owner-naming sentence and no step.
  it('offers a billing role the plan copy and the billing step on a trial refusal', async () => {
    mocks.role = 'owner';
    mocks.launch.mockRejectedValueOnce(trialRefusal());
    const resultRef = mountHook('org_1');

    await connect(resultRef, 'slack');

    expect(mocks.toastError).toHaveBeenCalledWith('common.organizationTrialEndedBilling', {
      action: { label: 'organization.hub.manageBilling', onClick: expect.any(Function) },
    });
    const [, options] = mocks.toastError.mock.calls.at(-1) as [string, ToastStepOptions];
    options.action?.onClick();
    // The screen reads its organization from the query, so the step names the
    // organization whose role it read instead of the persisted selection.
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/(tabs)/(3_profile)/organization/billing?org=org_1'
    );
  });

  it('keeps the owner-naming copy and adds no step for a member', async () => {
    mocks.role = 'member';
    mocks.launch.mockRejectedValueOnce(trialRefusal());
    const resultRef = mountHook('org_1');

    await connect(resultRef, 'slack');

    expect(mocks.toastError).toHaveBeenCalledWith('common.organizationTrialEnded');
    expect(mocks.toastError.mock.calls.at(-1)).toHaveLength(1);
  });
});

function trialRefusal(): Error {
  return Object.assign(new Error('Organization trial has expired.'), {
    data: { code: 'FORBIDDEN', message: 'Organization trial has expired.' },
  });
}

type ToastStepOptions = { action?: { label: string; onClick: () => void } };

function mountDisconnect(organizationId: string | undefined) {
  function Probe() {
    useDisconnectIntegration(organizationId);
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(Probe));
  });
  const mutation = mocks.mutation;
  if (!mutation) {
    throw new Error('useMutation was not called');
  }
  return mutation;
}

describe('useDisconnectIntegration', () => {
  it('offers a billing role the plan copy and the billing step on a trial refusal', () => {
    mocks.role = 'admin';
    const mutation = mountDisconnect('org_1');

    mutation.onError?.(trialRefusal(), { provider: 'slack', githubIntegrationId: null });

    expect(mocks.toastError).toHaveBeenCalledWith('common.organizationTrialEndedBilling', {
      action: { label: 'organization.hub.manageBilling', onClick: expect.any(Function) },
    });
  });

  it('keeps the owner-naming copy and adds no step for a member', () => {
    mocks.role = 'member';
    const mutation = mountDisconnect('org_1');

    mutation.onError?.(trialRefusal(), { provider: 'slack', githubIntegrationId: null });

    expect(mocks.toastError).toHaveBeenCalledWith('common.organizationTrialEnded');
    expect(mocks.toastError.mock.calls.at(-1)).toHaveLength(1);
  });

  it('keeps the provider copy and no step for any other refusal, even for a billing role', () => {
    mocks.role = 'owner';
    const mutation = mountDisconnect('org_1');

    mutation.onError?.(new Error('Network request failed'), {
      provider: 'slack',
      githubIntegrationId: null,
    });

    expect(mocks.toastError).toHaveBeenCalledWith('integrations.disconnectFailed');
    expect(mocks.toastError.mock.calls.at(-1)).toHaveLength(1);
  });
});
