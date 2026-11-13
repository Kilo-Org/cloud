import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import PrReviewIndexRoute from '@/app/(app)/pr-review/index';
import { OrganizationProvider } from '@/lib/organization-context';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

// The route on the reported pathname while a picker sheet is presented over it:
// expo-router reports the sheet's own route, not the one that mounted the screen.
const route = vi.hoisted(() => ({ pathname: '/context-picker' as string }));
const organizationList = vi.hoisted(() => vi.fn());
const githubAuthorization = vi.hoisted(() => vi.fn());
const organizationStorage = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }),
  useFocusEffect: () => undefined,
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: {
        queryOptions: () => ({ queryKey: ['organizations-list'], queryFn: organizationList }),
      },
    },
    githubApps: {
      getUserAuthorization: {
        queryOptions: () => ({
          queryKey: ['github-user-authorization'],
          queryFn: githubAuthorization,
        }),
        queryKey: () => ['github-user-authorization'],
      },
      connectUserAuthorization: {
        mutationOptions: () => ({ mutationFn: vi.fn() }),
        mutationKey: () => ['connect-user-authorization'],
      },
    },
  }),
}));
// The focus refresh is route plumbing; its fetch is not the subject here.
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: () => undefined,
}));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn().mockResolvedValue('') }));
// The connect gate imports the browser launcher at module load; this test
// never launches an authorization.
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  WebBrowserResultType: { OPENED: 'opened', DISMISS: 'dismiss', CANCEL: 'cancel' },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: organizationStorage,
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pr-review/recent-prs', () => ({
  getRecentPrs: vi.fn().mockResolvedValue([]),
  removeRecentPr: vi.fn(),
  recentPrKey: () => 'recent-key',
  providerRefFromRecentPr: () => ({ platform: 'github', owner: 'kilo', repo: 'cloud', number: 1 }),
}));
vi.mock('react-native', () => ({
  BackHandler: { addEventListener: vi.fn(() => ({ remove: () => undefined })) },
  Modal: (props: { visible?: boolean; children?: ReactNode }) =>
    props.visible ? createElement('Modal', null, props.children) : null,
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 18 }),
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }) =>
    createElement('ScreenHeader', null, props.headerRight),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
// The gate's GitHub mark draws through react-native-svg, whose Flow source the
// mounted transform cannot parse; this test reads copy and testIDs, not marks.
vi.mock('@/components/icons/github-icon', () => ({ GitHubIcon: 'GitHubIcon' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  Clipboard: 'Clipboard',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  ShieldAlert: 'ShieldAlert',
  PlugZap: 'PlugZap',
  RefreshCcw: 'RefreshCcw',
  WifiOff: 'WifiOff',
  X: 'X',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/pr-review/pr-link-placeholder', () => ({
  PrLinkPlaceholder: 'PrLinkPlaceholder',
}));
// The list container owns the scrolling surface, not the two sections this test
// renders through it; the form arrives as its `header` and the recents as its body.
vi.mock('@/components/pr-review/pr-review-inbox-list', () => ({
  PrReviewInboxList: (props: { header?: ReactNode; recents?: ReactNode }) =>
    createElement('PrReviewInboxList', null, props.header, props.recents),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: vi.fn() } }));

const ORG_A = { organizationId: 'org-a', organizationName: 'Acme', role: 'owner' };

const mounted: RenderWithProvidersResult[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  route.pathname = '/context-picker';
  organizationList.mockReset().mockResolvedValue([ORG_A]);
  organizationStorage.mockReset().mockResolvedValue('org-a');
  // A reader who has never authorized GitHub: the gate's connect state.
  githubAuthorization
    .mockReset()
    .mockResolvedValue({ connected: false, revoked: false, githubLogin: null });
});
afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('the PR review entry route under a presented account sheet', () => {
  it('keeps the link-entry form while the sheet route is the reported pathname', async () => {
    const ui = await renderWithProviders(createElement(PrReviewIndexRoute), {
      wrapper: OrganizationProvider,
    });
    mounted.push(ui);

    // The form the reader opened, with the account pill the sheet switches.
    const gateTitles = () =>
      ui.renderer.root.findAll(node => node.props.title === i18n.t('common.connectGithub'));

    // Wait for the route to paint one of the two states before saying which.
    await waitFor(
      () =>
        ui.renderer.root.findAll(node => node.props.testID === 'pr-link-input-row').length > 0 ||
        gateTitles().length > 0
    );

    // Not one provider's connect state: the mount serves all three providers,
    // so a sheet's own pathname must not re-gate the screen behind it.
    expect(gateTitles()).toHaveLength(0);
    expect(
      ui.renderer.root.findAll(node => node.props.testID === 'pr-link-input-row')
    ).not.toHaveLength(0);
    expect(
      ui.renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Acme' &&
          node.props.accessibilityHint === 'Select account'
      )
    ).not.toHaveLength(0);
    expect(
      ui.renderer.root.findAll(
        node => node.props.accessibilityLabel === i18n.t('prReview.entry.openAccessibility')
      )
    ).not.toHaveLength(0);
  });
});
