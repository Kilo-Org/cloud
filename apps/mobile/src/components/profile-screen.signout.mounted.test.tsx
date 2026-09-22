import { createElement } from 'react';
import { act, type TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfileScreen } from '@/components/profile-screen';
import { renderWithProviders } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const signOutFn = vi.hoisted(() => vi.fn());
const alertFn = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ os: 'android' as 'android' | 'ios' }));
const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native', () => ({
  Alert: { alert: alertFn },
  Modal: 'Modal',
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));

// `@/lib/screen-insets` reads `react-native-safe-area-context`, whose module
// imports `react-native/Libraries/Utilities/codegenNativeComponent` — a path
// this pipeline cannot parse, so the entry point is stubbed like the screens'
// other native reads.
// The Profile screen reads its landscape side insets through `@/lib/screen-insets`,
// whose real module loads the native safe-area package. The node project cannot
// load that native module, so the screen's own tests stub the hook.
// The screen reads its side insets through `@/lib/screen-insets`, which imports
// this native module; its untransformed source breaks the mounted project.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.0',
  nativeBuildVersion: '1',
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getAuthProviders: {
        queryOptions: () => ({ queryKey: ['user', 'getAuthProviders'], queryFn: vi.fn() }),
      },
    },
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations', 'list'], queryFn: vi.fn() }) },
    },
  }),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ signOut: signOutFn, token: 'token-1' }),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));

vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'mobile-pr-review',
  useFeatureFlag: () => true,
}));

vi.mock('@/components/use-delete-account', () => ({
  useDeleteAccount: () => ({
    phase: 'idle',
    isPending: false,
    devCode: null,
    beginDelete: vi.fn(),
    submitCode: vi.fn(),
    setCode: vi.fn(),
  }),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#B0483A', mutedForeground: '#000000' }),
}));

vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  useLanguagePreference: () => ({ preference: 'device', hasLoaded: true }),
}));

vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));

// The queries the actions section does not depend on stay deferred, so the
// sign-out tile is exercised without their interaction-manager flush.
vi.mock('@/lib/hooks/use-after-interactions', () => ({ useAfterInteractions: () => false }));

vi.mock('@/lib/profile-agent-navigation', () => ({
  getCodeReviewerProfilePath: () => '/code-reviewer',
  getProfileAgentScope: () => undefined,
  getPrReviewEntryPath: () => '/pr-review',
}));

vi.mock('@/lib/security-agent', () => ({ getSecurityAgentPath: () => '/security-agent' }));
vi.mock('@/lib/feedback', () => ({ showFeedbackPrompt: vi.fn() }));

vi.mock('@/components/ui/icons', () => ({
  BookOpenCheck: 'BookOpenCheck',
  Building2: 'Building2',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  Globe: 'Globe',
  KeyRound: 'KeyRound',
  Lock: 'Lock',
  LogOut: 'LogOut',
  MessageSquare: 'MessageSquare',
  ShieldCheck: 'ShieldCheck',
  SlidersHorizontal: 'SlidersHorizontal',
  Smartphone: 'Smartphone',
  Trash2: 'Trash2',
}));

vi.mock('@/components/profile-action-tile', () => ({ ActionTile: 'ActionTile' }));
vi.mock('@/components/profile-credits-card', () => ({ CreditsCard: 'CreditsCard' }));
vi.mock('@/components/language-picker-sheet', () => ({
  LanguagePickerSheet: 'LanguagePickerSheet',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

// ── Tests ──────────────────────────────────────────────────────────────────

function isType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

describe('ProfileScreen sign-out confirmation', () => {
  beforeEach(() => {
    signOutFn.mockReset();
    alertFn.mockReset();
  });

  function pressSignOutTile(renderer: TestRenderer.ReactTestRenderer) {
    const tile = renderer.root.find(
      node => isType(node, 'ActionTile') && node.props.label === 'Sign out'
    );
    act(() => {
      (tile.props as { onPress?: () => void }).onPress?.();
    });
  }

  // One cross-platform implementation for the sign-out confirmation: the
  // native `Alert.alert`, the app-wide destructive pattern
  // (`apps/mobile/AGENTS.md`: "Confirm destructive actions with `Alert.alert()`").
  // Both platforms run the same code path — Android's alert ignores the
  // destructive style, so the affordance there is the label, not red.
  for (const os of ['android', 'ios'] as const) {
    it(`shows the native confirmation whose destructive button signs out on ${os}`, async () => {
      platform.os = os;
      const { renderer, unmount } = await renderWithProviders(createElement(ProfileScreen));

      pressSignOutTile(renderer);

      // The confirmation is the native alert on both platforms, never an in-app
      // dialog.
      expect(alertFn).toHaveBeenCalledWith(
        'Sign out?',
        'You will need to sign in again to access your workspace.',
        expect.any(Array)
      );
      expect(
        renderer.root.findAll(
          node => isType(node, 'Button') && node.props.variant === 'destructive'
        )
      ).toHaveLength(0);
      // Opening the confirmation signs nobody out; only its destructive button does.
      expect(signOutFn).not.toHaveBeenCalled();
      const buttons = alertFn.mock.calls[0]?.[2] as
        | { style?: string; onPress?: () => void }[]
        | undefined;
      const destructive = buttons?.find(button => button.style === 'destructive');
      act(() => {
        destructive?.onPress?.();
      });
      expect(signOutFn).toHaveBeenCalledTimes(1);

      unmount();
    });
  }
});
