import { createElement } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';

import '@/i18n';
import { ProfileScreen } from '@/components/profile-screen';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const providersQueryFn = vi.hoisted(() => vi.fn());
const organizationsQueryFn = vi.hoisted(() => vi.fn());
const signOutFn = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const keys = vi.hoisted(() => ({
  providers: ['user', 'getAuthProviders'],
  organizations: ['organizations', 'list'],
}));
const authState = vi.hoisted(() => ({ token: 'token-1' as string | null }));
const interactionState = vi.hoisted(() => ({
  storedCallback: undefined as (() => void) | undefined,
  cancel: vi.fn(),
}));
// eslint-disable-next-line promise/prefer-await-to-callbacks -- the mock must capture the callback so the test can flush it
const captureInteraction = vi.hoisted(() => (cb: () => void) => {
  interactionState.storedCallback = cb;
  return { cancel: interactionState.cancel };
});
const getProfileAgentScopeMock = vi.hoisted(() => vi.fn());

export {
  authState,
  getProfileAgentScopeMock,
  interactionState,
  keys,
  organizationsQueryFn,
  providersQueryFn,
  routerPush,
  signOutFn,
};

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  View: 'View',
  InteractionManager: {
    runAfterInteractions: vi.fn(captureInteraction),
  },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.0',
  nativeBuildVersion: '1',
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getAuthProviders: {
        queryOptions: () => ({ queryKey: keys.providers, queryFn: providersQueryFn }),
      },
    },
    organizations: {
      list: {
        queryOptions: () => ({ queryKey: keys.organizations, queryFn: organizationsQueryFn }),
      },
    },
  }),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ signOut: signOutFn, token: authState.token }),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1', isLoaded: true }),
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
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  useLanguagePreference: () => ({ preference: 'device', hasLoaded: true }),
}));

vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));

vi.mock('@/lib/profile-agent-navigation', () => ({
  getCodeReviewerProfilePath: () => '/code-reviewer',
  getProfileAgentScope: getProfileAgentScopeMock,
  getPrReviewEntryPath: () => '/pr-review',
}));

vi.mock('@/lib/security-agent', () => ({
  getSecurityAgentPath: () => '/security-agent',
}));

vi.mock('@/lib/feedback', () => ({
  showFeedbackPrompt: vi.fn(),
}));

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

// ── Helpers ────────────────────────────────────────────────────────────────

export function nodeCount(root: ReactTestInstance, type: string): number {
  return root.findAll(node => typeof node.type === 'string' && node.type === type).length;
}

export function findNode(root: ReactTestInstance, type: string): ReactTestInstance | undefined {
  return root.findAll(node => typeof node.type === 'string' && node.type === type)[0];
}

export function nodeCountWithChildren(
  root: ReactTestInstance,
  type: string,
  children: string
): number {
  return root.findAll(
    node => typeof node.type === 'string' && node.type === type && node.props.children === children
  ).length;
}

export function findConfigureRows(root: ReactTestInstance, title: string): ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'ConfigureRow' &&
      node.props.title === title
  );
}

/** Mount the screen; pass a client to seed cached data, e.g. a cached error. */
export async function mountProfile(queryClient?: QueryClient) {
  const result = await renderWithProviders(
    createElement(ProfileScreen),
    queryClient ? { queryClient } : {}
  );
  return result;
}

export function flushInteractions() {
  const run = interactionState.storedCallback;
  if (!run) {
    throw new Error('runAfterInteractions callback was not captured');
  }
  act(() => {
    run();
  });
}

/**
 * Advance the fake clock in small steps until `predicate` holds.
 *
 * TanStack Query batches observer notifications through a `setTimeout(…, 0)`
 * scheduler, so a mounted test that drives a fallback on the fake clock has to
 * keep ticking it for fetched data to reach the tree.
 */
export async function advanceUntil(predicate: () => boolean, budgetMs: number): Promise<void> {
  for (let elapsed = 0; elapsed <= budgetMs; elapsed += 25) {
    if (predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- the fake clock must tick and re-check sequentially between act cycles
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
  }
  throw new Error(`advanceUntil: condition not met within ${budgetMs}ms of fake time`);
}
