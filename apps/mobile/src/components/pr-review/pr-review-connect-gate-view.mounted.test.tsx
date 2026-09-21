import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import { toast } from 'sonner-native';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { type ProviderPrPlatform } from '@/lib/pr-review/provider-pr-ref';
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
let queryResult = {
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
vi.mock('expo-router', () => ({ usePathname: () => '/pr-review/github/owner/repo/1' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
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
  EmptyState: (props: { action?: React.ReactNode }) =>
    React.createElement('EmptyState', props, props.action),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
  Platform: platform,
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

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;
function gate(provider: ProviderPrPlatform, organizationId: string | null = 'org-1') {
  return (
    <PrReviewConnectGate platform={provider} organizationId={organizationId}>
      {React.createElement('ReviewContent')}
    </PrReviewConnectGate>
  );
}
function mount(provider: ProviderPrPlatform, organizationId: string | null = 'org-1') {
  act(() => {
    mounted = TestRenderer.create(gate(provider, organizationId));
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
    await act(async () => {
      (renderer.root.findByType('Button').props.onPress as () => void)();
      await Promise.resolve();
    });
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
    const button = renderer.root.findByType('Button');
    expect(button.props.disabled).toBe(false);

    await act(async () => {
      (button.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(button.props.disabled).toBe(true);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(queryResult.refetch).not.toHaveBeenCalled();

    await settleLaunch(pending);
    expect(queryResult.refetch).toHaveBeenCalledOnce();
    expect(button.props.disabled).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(providers)(
    '%s reports a failed launch, re-enables Connect, and refreshes once after retry',
    async provider => {
      failLaunch(new Error('no browser'));
      const renderer = mount(provider);
      const button = renderer.root.findByType('Button');

      await act(async () => {
        (button.props.onPress as () => void)();
        await Promise.resolve();
      });
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        'Could not open browser. Please try again.'
      );
      expect(button.props.disabled).toBe(false);
      expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
      expect(queryResult.refetch).not.toHaveBeenCalled();

      // The failed launch must leave no listener that could stray-refetch, so
      // the retry below is the only thing that refreshes.
      emitForeground();
      expect(queryResult.refetch).not.toHaveBeenCalled();

      const retry = beginPendingLaunch();
      await act(async () => {
        (button.props.onPress as () => void)();
        await Promise.resolve();
      });
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
      const button = renderer.root.findByType('Button');
      await act(async () => {
        (button.props.onPress as () => void)();
        await Promise.resolve();
      });
      await settleLaunch(pending);
      expect(queryResult.refetch).toHaveBeenCalledOnce();
      expect(button.props.disabled).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it('explains the personal Bitbucket restriction without a Connect CTA', () => {
    const renderer = mount('bitbucket', null);
    expect(renderer.root.findByType('EmptyState').props.description).toBeTruthy();
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it('shows the GitHub icon in the Connect GitHub action', () => {
    const renderer = mount('github');
    expect(renderer.root.findAllByType('GitHubIcon')).toHaveLength(1);
    expect(renderer.root.findAllByType('RefreshCcw')).toHaveLength(0);
  });
});
