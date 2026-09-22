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

  // One cross-platform implementation: the sign-out tile opens the in-app
  // destructive dialog on iOS and Android alike, and only its destructive
  // control signs out. Android's native alert cannot render the destructive
  // style (see DestructiveConfirmDialog), so the shared surface is what carries
  // the red affordance on both platforms, with no per-platform branch.
  for (const os of ['android', 'ios'] as const) {
    it(`opens the in-app destructive dialog and signs out from it on ${os}`, async () => {
      platform.os = os;
      const { renderer, unmount } = await renderWithProviders(createElement(ProfileScreen));

      pressSignOutTile(renderer);

      // The confirmation is the in-app dialog on both platforms, never the
      // native alert.
      expect(alertFn).not.toHaveBeenCalled();
      // Opening the confirmation signs nobody out; only its destructive control does.
      expect(signOutFn).not.toHaveBeenCalled();
      const confirm = renderer.root.find(
        node => isType(node, 'Button') && node.props.variant === 'destructive'
      );
      act(() => {
        (confirm.props as { onPress?: () => void }).onPress?.();
      });
      expect(signOutFn).toHaveBeenCalledTimes(1);

      unmount();
    });
  }
});
