/* eslint-disable max-lines -- one gate harness runs the provider × platform matrix; the header Back test shares its mount and router mocks. */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import { toast } from 'sonner-native';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import {
  type ProviderPrPlatform,
  type ProviderPrRef,
  ProviderPrScopeProvider,
} from '@/lib/pr-review/provider-pr-ref';
import { PrReviewConnectGate } from './pr-review-connect-gate';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const appState = vi.hoisted(() => ({
  subscriptions: [] as {
    remove: ReturnType<typeof vi.fn>;
    listener: (state: string) => void;
  }[],
  addEventListener: vi.fn(),
}));
const providers: ProviderPrPlatform[] = ['github', 'gitlab', 'bitbucket'];
type MockStatusData = {
  connected: boolean;
  revoked?: boolean;
  reconnectRequired?: boolean;
  /** The GitLab status read's connected instance, as the server reports it. */
  integration?: { instanceUrl: string } | null;
};

type MockQueryResult = {
  data: MockStatusData;
  isPending: boolean;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: Mock;
};

let queryResult: MockQueryResult = {
  data: { connected: false, revoked: false },
  isPending: false,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};
const connectMutateAsync = vi.fn<() => Promise<{ authorizationUrl: string }>>();

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryResult,
  useMutation: () => ({ mutateAsync: connectMutateAsync, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: { queryOptions: () => ({}), queryKey: () => [] },
      connectUserAuthorization: { mutationOptions: () => ({}) },
    },
    organizations: {
      reviewAgent: {
        getGitLabStatus: { queryOptions: () => ({}) },
        getBitbucketReadiness: { queryOptions: () => ({}) },
      },
    },
    personalReviewAgent: { getGitLabStatus: { queryOptions: () => ({}) } },
  }),
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://web.example' }));
const router = vi.hoisted(() => ({ dismissTo: vi.fn() }));
vi.mock('expo-router', () => ({
  usePathname: () => '/pr-review/github/owner/repo/1',
  useRouter: () => router,
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    React.useEffect(effect, [effect]);
  },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));
// The provider gate reads the memberships answer to word the Bitbucket
// org-only guidance; this harness always has one organization.
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({ data: [{ organizationId: 'org-1' }] }),
}));
// The role split that decides whether an organization keeps the Connect CTA is
// covered by pr-review-provider-connect-gate.mounted.test.tsx; this harness
// pins a billing role so every arm still offers the launch it exercises.
vi.mock('@/lib/hooks/use-reviewer-permission', () => ({
  useReviewerPermission: () => ({ status: 'ready', canEdit: true, canManage: true }),
}));
// The layout publishes the restored account selection and the gate reads the
// same context; this harness is always past that restore.
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1', isLoaded: true }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  WebBrowserResultType: { OPENED: 'opened', DISMISS: 'dismiss', CANCEL: 'cancel' },
}));
vi.mock('@/components/ui/icons', () => ({
  PlugZap: 'PlugZap',
  RefreshCcw: 'RefreshCcw',
  ShieldAlert: 'ShieldAlert',
}));
vi.mock('@/components/icons/github-icon', () => ({ GitHubIcon: 'GitHubIcon' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { description?: React.ReactNode; action?: React.ReactNode }) =>
    React.createElement('EmptyState', props, props.description, props.action),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
// The context line owns its own org queries; the gate tests stub it and pin
// only the props the gate passes (its content is covered by its own test).
vi.mock('@/components/pr-review/pr-review-context-line', () => ({
  PrReviewContextLine: 'PrReviewContextLine',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Platform: platform,
  useColorScheme: () => 'light',
  View: 'View',
}));

function emitForeground() {
  for (const subscription of appState.subscriptions) {
    subscription.listener('active');
  }
}

/** Begins a launch that stays open until the test settles it. */
function beginPendingLaunch() {
  if (platform.OS === 'android') {
    const pending = Promise.withResolvers<WebBrowser.WebBrowserResult>();
    vi.mocked(WebBrowser.openBrowserAsync).mockReturnValueOnce(pending.promise);
    return {
      settle: () => {
        pending.resolve({ type: WebBrowser.WebBrowserResultType.OPENED });
      },
    };
  }
  const pending = Promise.withResolvers<WebBrowser.WebBrowserAuthSessionResult>();
  vi.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(pending.promise);
  return {
    settle: () => {
      pending.resolve({ type: WebBrowser.WebBrowserResultType.CANCEL });
    },
  };
}

/** Settles the launch as a successful return: sheet close (iOS) / foreground (Android). */
async function settleLaunch(pending: ReturnType<typeof beginPendingLaunch>) {
  await act(async () => {
    pending.settle();
    await Promise.resolve();
    if (platform.OS === 'android') {
      emitForeground();
    }
    await Promise.resolve();
  });
}

function failLaunch(error: Error) {
  if (platform.OS === 'android') {
    vi.mocked(WebBrowser.openBrowserAsync).mockRejectedValueOnce(error);
  } else {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockRejectedValueOnce(error);
  }
}

/** Presses the gate's Connect button and lets the launch promise settle one tick. */
async function pressConnect(renderer: TestRenderer.ReactTestRenderer) {
  const button = renderer.root.findByType('Button');
  await act(async () => {
    (button.props.onPress as () => void)();
    await Promise.resolve();
  });
  return button;
}

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;
function gate(
  provider: ProviderPrPlatform,
  organizationId: string | null = 'org-1',
  ref?: ProviderPrRef
) {
  return (
    <PrReviewConnectGate platform={provider} organizationId={organizationId} prRef={ref}>
      {React.createElement('ReviewContent')}
    </PrReviewConnectGate>
  );
}
function mount(
  provider: ProviderPrPlatform,
  organizationId: string | null = 'org-1',
  ref?: ProviderPrRef
) {
  act(() => {
    mounted = TestRenderer.create(gate(provider, organizationId, ref));
  });
  if (!mounted) {
    throw new Error('gate did not mount');
  }
  return mounted;
}

beforeEach(() => {
  vi.resetAllMocks();
  appState.subscriptions.length = 0;
  appState.addEventListener.mockImplementation(
    (_event: string, listener: (state: string) => void) => {
      const subscription = { remove: vi.fn(), listener };
      appState.subscriptions.push(subscription);
      return { remove: subscription.remove };
    }
  );
  queryResult = {
    data: { connected: false, revoked: false },
    isPending: false,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  };
  connectMutateAsync.mockResolvedValue({
    authorizationUrl: 'https://github.com/login/oauth/authorize',
  });
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('Android connect gate unmount', () => {
  it.each(providers)('%s drops its foreground listener and pending callbacks', async provider => {
    platform.OS = 'android';
    vi.mocked(WebBrowser.openBrowserAsync).mockResolvedValue({
      type: WebBrowser.WebBrowserResultType.OPENED,
    });
    const renderer = mount(provider);
    await pressConnect(renderer);
    expect(appState.subscriptions).toHaveLength(1);

    await act(async () => {
      renderer.unmount();
      await Promise.resolve();
    });
    mounted = undefined;
    expect(appState.subscriptions[0]?.remove).toHaveBeenCalledOnce();
    await act(async () => {
      emitForeground();
      await Promise.resolve();
    });
    expect(queryResult.refetch).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe.each(['ios', 'android'])('PR-review connect gate on %s', os => {
  beforeEach(() => {
    platform.OS = os;
  });

  it.each(providers)('%s waits for the launch to finish before refreshing', async provider => {
    const pending = beginPendingLaunch();
    const renderer = mount(provider);
    const button = await pressConnect(renderer);
    expect(button.props.disabled).toBe(true);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(queryResult.refetch).not.toHaveBeenCalled();

    await settleLaunch(pending);
    expect(queryResult.refetch).toHaveBeenCalledOnce();
    expect(button.props.disabled).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(providers)(
    '%s reports a failed launch, re-enables Connect, and refreshes',
    async provider => {
      failLaunch(new Error('no browser'));
      const renderer = mount(provider);
      const button = await pressConnect(renderer);
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        'Could not open browser. Please try again.'
      );
      expect(button.props.disabled).toBe(false);
      expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
      expect(queryResult.refetch).not.toHaveBeenCalled();

      // The failed launch leaves no stray listener: the retry below is the
      // only thing that refreshes.
      emitForeground();
      expect(queryResult.refetch).not.toHaveBeenCalled();

      const retry = beginPendingLaunch();
      await pressConnect(renderer);
      expect(button.props.disabled).toBe(true);

      await settleLaunch(retry);
      expect(queryResult.refetch).toHaveBeenCalledOnce();
      expect(toast.error).toHaveBeenCalledOnce();
      expect(button.props.disabled).toBe(false);
      expect(renderer.root.findAllByType('EmptyState')).toHaveLength(1);

      queryResult.data.connected = true;
      act(() => {
        renderer.update(gate(provider));
      });
      expect(renderer.root.findAllByType('ReviewContent')).toHaveLength(1);
      expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    }
  );

  it.each(providers)('%s shows loading, not Connect, for a paused status query', provider => {
    queryResult.isPending = true;
    const renderer = mount(provider);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(renderer.root.findAllByType('EmptyState')).toHaveLength(0);
  });

  it.each(providers)('%s offers a working Retry for status failures', async provider => {
    queryResult.isError = true;
    const renderer = mount(provider);
    await act(async () => {
      (renderer.root.findByType('QueryError').props.onRetry as () => void)();
      await Promise.resolve();
    });
    expect(queryResult.refetch).toHaveBeenCalledOnce();
  });

  it.each(providers)(
    '%s handles a rejected return refetch without a browser error',
    async provider => {
      queryResult.refetch.mockRejectedValue(new Error('status refetch failed'));
      const pending = beginPendingLaunch();
      const renderer = mount(provider);
      const button = await pressConnect(renderer);
      await settleLaunch(pending);
      expect(queryResult.refetch).toHaveBeenCalledOnce();
      expect(button.props.disabled).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it.each(providers)(
    '%s returns Connect to idle when the return refetch never settles',
    async provider => {
      // Default `networkMode: 'online'`: while the online manager reports
      // offline the awaited read stays pending for good. The CTA must not wait
      // on it — the user already backed out of the sign-in sheet.
      const neverSettles = Promise.withResolvers<undefined>();
      queryResult.refetch.mockReturnValue(neverSettles.promise);
      const pending = beginPendingLaunch();
      const renderer = mount(provider);
      const button = await pressConnect(renderer);
      expect(button.props.disabled).toBe(true);

      await settleLaunch(pending);

      expect(queryResult.refetch).toHaveBeenCalledOnce();
      expect(button.props.disabled).toBe(false);
      expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it('explains the personal Bitbucket restriction without a Connect CTA', () => {
    const renderer = mount('bitbucket', null);
    expect(renderer.root.findByType('EmptyState').props.description).toBeTruthy();
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it.each(['github', 'gitlab'] as const)(
    '%s asks to re-authorize an existing connection instead of a first-time connect',
    provider => {
      queryResult.data =
        provider === 'github'
          ? { connected: false, revoked: true }
          : { connected: false, reconnectRequired: true };
      const expectedTitle =
        provider === 'github' ? 'Reconnect GitHub' : 'GitLab connection expired';
      // The GitHub arm labels its recovery action with the same reconnect
      // copy; the provider gate's action is the integration-page CTA, so it
      // keeps that provider's Connect label.
      const expectedAction = provider === 'github' ? 'Reconnect GitHub' : 'Connect GitLab';
      const renderer = mount(provider, null);
      const emptyState = renderer.root.findByType('EmptyState');
      expect(emptyState.props.title).toBe(expectedTitle);
      // The recovery action is the same integration-page CTA as Connect, so
      // its label is the provider's Connect label rather than the expired-state
      // title above it.
      const labels = renderer.root
        .findAllByType('Text')
        .map(node => node.children.find(child => typeof child === 'string'));
      expect(labels).toContain(expectedAction);
    }
  );

  it.each(['gitlab', 'bitbucket'] as const)(
    '%s keeps the first-time Connect copy when the status carries no reconnect marker',
    provider => {
      queryResult.data = { connected: false };
      const noun = provider === 'gitlab' ? 'GitLab' : 'Bitbucket';
      const renderer = mount(provider, provider === 'bitbucket' ? 'org-1' : null);
      const emptyState = renderer.root.findByType('EmptyState');
      expect(emptyState.props.title).toBe(`Connect ${noun}`);
    }
  );

  it('a personal GitLab reconnect CTA opens the personal integration page', async () => {
    platform.OS = 'android';
    queryResult.data = { connected: false, reconnectRequired: true };
    const pending = beginPendingLaunch();
    const renderer = mount('gitlab', null);
    await pressConnect(renderer);
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledExactlyOnceWith(
      'https://web.example/integrations/gitlab'
    );
    expect(queryResult.refetch).not.toHaveBeenCalled();

    await settleLaunch(pending);
    expect(queryResult.refetch).toHaveBeenCalledOnce();
  });

  it('shows the GitHub icon in the Connect GitHub action', () => {
    const renderer = mount('github');
    expect(renderer.root.findAllByType('GitHubIcon')).toHaveLength(1);
    expect(renderer.root.findAllByType('RefreshCcw')).toHaveLength(0);
  });

  it.each(providers)('%s Back dismisses to the PR Review inbox, not the app root', provider => {
    const onBack = mount(provider).root.findByType('ScreenHeader').props.onBack as () => void;
    onBack();
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/(app)/pr-review');
  });

  it.each(providers)('%s names the active context on the connect view', provider => {
    const renderer = mount(provider);
    expect(renderer.root.findAllByType('PrReviewContextLine')).toHaveLength(1);
  });
});

describe('PR-review connect gate item line', () => {
  /** The one `Text` the gate renders for the opened PR/MR, if any. */
  function itemLine(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root
      .findAllByType('Text')
      .find(
        node => typeof node.props.children === 'string' && /[#!]\d+$/.test(node.props.children)
      );
  }

  const GITHUB: ProviderPrRef = {
    platform: 'github',
    owner: 'acme-design',
    repo: 'atlas-redesign',
    number: 4821,
  };
  const GITLAB: ProviderPrRef = {
    platform: 'gitlab',
    projectPath: 'group/sub/repo',
    mrIid: 1287,
  };
  const BITBUCKET: ProviderPrRef = {
    platform: 'bitbucket',
    workspace: 'acme-design',
    repoSlug: 'atlas-redesign',
    prId: 42,
  };

  it('names the GitHub pull request the opened link carries', () => {
    const line = itemLine(mount('github', null, GITHUB));
    expect(line?.props.children).toBe('acme-design/atlas-redesign#4821');
    // A long nested path must not wrap into a second line and push the copy
    // and the CTA down; the ellipsis sits in the middle so the number and the
    // last path segment stay readable.
    expect(line?.props.numberOfLines).toBe(1);
    expect(line?.props.ellipsizeMode).toBe('middle');
    // An identifier keeps a left-to-right base direction under an RTL locale
    // while it stays centered like the copy around it.
    expect(line?.props.style).toMatchObject({ direction: 'ltr', writingDirection: 'ltr' });
    expect(line?.props.className).toContain('text-center');
  });

  it('names the same pull request when the connection needs re-authorizing', () => {
    queryResult.data = { connected: false, revoked: true };
    const line = itemLine(mount('github', null, GITHUB));
    expect(line?.props.children).toBe('acme-design/atlas-redesign#4821');
  });

  it('names a nested GitLab merge request by its full project path and iid', () => {
    const line = itemLine(mount('gitlab', null, GITLAB));
    expect(line?.props.children).toBe('group/sub/repo!1287');
  });

  it('names the Bitbucket pull request in the organization-only explanation', () => {
    const renderer = mount('bitbucket', null, BITBUCKET);
    expect(itemLine(renderer)?.props.children).toBe('acme-design/atlas-redesign#42');
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
  });

  it('keeps the generic gate when the mount knows no item', () => {
    const renderer = mount('github');
    expect(itemLine(renderer)).toBeUndefined();
    expect(renderer.root.findAllByType('EmptyState')).toHaveLength(1);
  });
});

describe('PR-review connect gate — GitLab instance mismatch', () => {
  const SELF_MANAGED: ProviderPrRef = {
    platform: 'gitlab',
    projectPath: 'group/sub/repo',
    mrIid: 18,
    instanceHint: 'https://gitlab.example.com',
  };
  const MISMATCH_DESCRIPTION =
    'Your GitLab connection is for gitlab.com, but this merge request is on ' +
    'gitlab.example.com. Connect GitLab on that instance to review it.';

  /** Mounts the gate inside the provider scope the route publishes. */
  function mountInScope(ref: ProviderPrRef, organizationId: string | null = null) {
    act(() => {
      mounted = TestRenderer.create(
        <ProviderPrScopeProvider value={{ ref, organizationId }}>
          {gate('gitlab', organizationId, ref)}
        </ProviderPrScopeProvider>
      );
    });
    if (!mounted) {
      throw new Error('gate did not mount');
    }
    return mounted;
  }

  function textValues(renderer: TestRenderer.ReactTestRenderer): (string | undefined)[] {
    return renderer.root
      .findAllByType('Text')
      .map(node => node.children.find(child => typeof child === 'string'));
  }

  it('explains the wrong instance instead of a deleted merge request', () => {
    queryResult.data = {
      connected: true,
      reconnectRequired: false,
      integration: { instanceUrl: 'https://gitlab.com' },
    };
    const renderer = mountInScope(SELF_MANAGED);

    expect(renderer.root.findByType('EmptyState').props.title).toBe(
      'GitLab connection is for another instance'
    );
    expect(textValues(renderer)).toContain(MISMATCH_DESCRIPTION);
    // The surface below the gate never mounts, so its "may have been deleted"
    // state cannot be reached. The one action is the integration-page CTA.
    expect(renderer.root.findAllByType('ReviewContent')).toHaveLength(0);
    expect(textValues(renderer)).toContain('Connect GitLab');
    expect(renderer.root.findAllByType('Button')).toHaveLength(1);
    // The description already names the requested host.
    expect(textValues(renderer)).not.toContain('https://gitlab.example.com');
  });

  it('renders the review when the connection serves the merge request instance', () => {
    queryResult.data = {
      connected: true,
      reconnectRequired: false,
      integration: { instanceUrl: 'https://gitlab.example.com' },
    };
    const renderer = mountInScope(SELF_MANAGED);
    expect(renderer.root.findAllByType('ReviewContent')).toHaveLength(1);
    expect(renderer.root.findAllByType('EmptyState')).toHaveLength(0);
  });

  it('compares a gitlab.com link, which the context line never names', () => {
    // The display hint drops the gitlab.com default, but the server still
    // compares it: a self-managed connection cannot read a gitlab.com link.
    queryResult.data = {
      connected: true,
      reconnectRequired: false,
      integration: { instanceUrl: 'https://gitlab.example.com' },
    };
    const renderer = mountInScope({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 18,
      instanceHint: 'https://gitlab.com',
    });
    expect(renderer.root.findByType('EmptyState').props.title).toBe(
      'GitLab connection is for another instance'
    );
    expect(textValues(renderer)).toContain(
      'Your GitLab connection is for gitlab.example.com, but this merge request is on ' +
        'gitlab.com. Connect GitLab on that instance to review it.'
    );
    expect(renderer.root.findAllByType('ReviewContent')).toHaveLength(0);
  });

  it('never compares a merge request whose link named no instance', () => {
    queryResult.data = {
      connected: true,
      reconnectRequired: false,
      integration: { instanceUrl: 'https://gitlab.com' },
    };
    const renderer = mountInScope({ platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 18 });
    expect(renderer.root.findAllByType('ReviewContent')).toHaveLength(1);
  });

  it('opens the organization integration page from the mismatch CTA', async () => {
    platform.OS = 'android';
    queryResult.data = {
      connected: true,
      reconnectRequired: false,
      integration: { instanceUrl: 'https://gitlab.com' },
    };
    const pending = beginPendingLaunch();
    const renderer = mountInScope(SELF_MANAGED, 'org-1');
    await pressConnect(renderer);
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledExactlyOnceWith(
      'https://web.example/organizations/org-1/integrations/gitlab'
    );
    await settleLaunch(pending);
  });
});
