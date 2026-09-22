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
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));

// The native safe-area module cannot load in this node environment. The screen
// reads its landscape side insets from it, so the mock returns the hoisted
// `safeArea`; the alignment guard in `screen-insets.test.ts` holds that read to
// the shared entry point.
// ProfileScreen reads the landscape side insets, so the real native module
// would load here. Its build requires `react-native` itself, whose Flow source
// the vitest transform cannot parse (see `test/render-with-providers.tsx`), so
// the harness mocks it exactly as `profile-screen.queries.mounted.test.tsx` does.
// ProfileScreen reads the landscape side insets, so the real native module
// would load here. Its build requires `react-native` itself, whose Flow source
// the vitest transform cannot parse (see `test/render-with-providers.tsx`), so
// the harness mocks it exactly as `profile-screen.queries.mounted.test.tsx` does.
// The screen reads its side insets through `@/lib/screen-insets`, whose real
// `react-native-safe-area-context` entry is a Flow source this pipeline cannot
// transform; the insets are irrelevant to the sign-out flow.
// The screen reads its side insets through `@/lib/screen-insets`; the native
// module's source is not parseable by this project's transform, and the
// sign-out confirmation does not depend on the values.
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

function alertButtons(call: unknown): { style?: string; onPress?: () => void }[] {
  const buttons = (call as unknown[] | undefined)?.[2];
  return Array.isArray(buttons) ? (buttons as { style?: string; onPress?: () => void }[]) : [];
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

  // The confirmation is the one shared native alert on both platforms:
  // plugins/withAndroidAlertDialogTheme repaints Android's AppCompat dialog with
  // the app tokens, and iOS's `UIAlertController` already follows the device
  // appearance. No platform mounts an in-app confirmation of its own, so the
  // same tap takes the same path whichever value the device reports.
  for (const os of ['android', 'ios'] as const) {
    it(`opens the shared native alert on ${os}`, async () => {
      platform.os = os;
      const { renderer, unmount } = await renderWithProviders(createElement(ProfileScreen));

      pressSignOutTile(renderer);

      expect(alertFn).toHaveBeenCalledTimes(1);
      expect(alertFn.mock.calls[0]?.[0]).toBe('Sign out?');
      // Opening the confirmation signs nobody out; only its own choices act.
      expect(signOutFn).not.toHaveBeenCalled();
      const buttons = alertButtons(alertFn.mock.calls[0]);
      expect(buttons.find(button => button.style === 'cancel')?.onPress).toBeUndefined();
      expect(buttons.some(button => button.style === 'destructive')).toBe(true);
      // The alert is the whole confirmation: no in-app dialog renders beside it.
      expect(
        renderer.root.findAll(
          node => isType(node, 'Button') && node.props.variant === 'destructive'
        )
      ).toHaveLength(0);

      unmount();
    });
  }

  it("signs out only when the alert's destructive choice is pressed", async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(ProfileScreen));

    pressSignOutTile(renderer);

    const destructive = alertButtons(alertFn.mock.calls[0]).find(
      button => button.style === 'destructive'
    );
    act(() => {
      destructive?.onPress?.();
    });
    expect(signOutFn).toHaveBeenCalledTimes(1);

    unmount();
  });
});
