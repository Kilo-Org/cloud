import { createElement } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfileScreen } from '@/components/profile-screen';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

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
const safeArea = vi.hoisted(() => ({ top: 24, bottom: 0, left: 0, right: 0 }));
const getProfileAgentScopeMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea,
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

function nodeCount(root: ReactTestInstance, type: string): number {
  return root.findAll(node => typeof node.type === 'string' && node.type === type).length;
}

function findNode(root: ReactTestInstance, type: string): ReactTestInstance | undefined {
  return root.findAll(node => typeof node.type === 'string' && node.type === type)[0];
}

function nodeCountWithChildren(root: ReactTestInstance, type: string, children: string): number {
  return root.findAll(
    node => typeof node.type === 'string' && node.type === type && node.props.children === children
  ).length;
}

function findConfigureRows(root: ReactTestInstance, title: string): ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'ConfigureRow' &&
      node.props.title === title
  );
}

function expectAlignedContent(root: ReactTestInstance) {
  const scroll = findNode(root, 'ScrollView');
  expect.soft(scroll?.props.contentContainerClassName).toBe('px-4 pt-4');
  expect(scroll?.props.style).toEqual({ marginLeft: safeArea.left, marginRight: safeArea.right });
  expect(findNode(root, 'CreditsCard')?.parent).toBe(scroll);
}

async function mountProfile() {
  const result = await renderWithProviders(createElement(ProfileScreen));
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProfileScreen mount queries', () => {
  beforeEach(() => {
    providersQueryFn.mockReset();
    organizationsQueryFn.mockReset();
    signOutFn.mockReset();
    routerPush.mockReset();
    authState.token = 'token-1';
    getProfileAgentScopeMock.mockReset();
    getProfileAgentScopeMock.mockReturnValue('personal');
    Object.assign(safeArea, { top: 24, bottom: 0, left: 0, right: 0 });
  });

  it.each([
    { left: 0, right: 0 },
    { left: 40, right: 0 },
    { left: 0, right: 40 },
    { left: 47, right: 59 },
  ])('aligns the content with the header gutter for side insets $left/$right', async insets => {
    Object.assign(safeArea, insets);
    const { renderer, unmount } = await renderWithProviders(createElement(ProfileScreen));

    expectAlignedContent(renderer.root);

    unmount();
  });

  it('fires both queries at mount, not after an interaction frame, and shows the skeleton until they settle', async () => {
    // Held in flight: the assertions below run while nothing has resolved yet.
    providersQueryFn.mockReturnValue(new Promise(() => undefined));
    organizationsQueryFn.mockReturnValue(new Promise(() => undefined));

    const { renderer, unmount } = await mountProfile();

    // Both queries are already in flight from the mount effect: nothing waits
    // for an interaction frame, so the screen settles in one wave.
    expect(providersQueryFn).toHaveBeenCalledTimes(1);
    expect(organizationsQueryFn).toHaveBeenCalledTimes(1);
    // The content-shaped skeleton (icon tile + two text bars) owns the section
    // while the fetch is in flight, and the agent rows are held disabled
    // (refreshing argument is true).
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(3);
    expect(getProfileAgentScopeMock.mock.calls.at(-1)?.[2]).toBe(true);
    expectAlignedContent(renderer.root);

    unmount();
  });

  it('renders cached providers without the skeleton at mount', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(keys.providers, {
      providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
    });
    queryClient.setQueryData(keys.organizations, [
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
    ]);

    const { renderer, unmount } = await renderWithProviders(createElement(ProfileScreen), {
      queryClient,
    });

    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);
    expect(findConfigureRows(renderer.root, 'GitHub').length).toBe(1);
    expectAlignedContent(renderer.root);

    unmount();
  });

  it('renders QueryError with retry when the providers query fails', async () => {
    providersQueryFn.mockRejectedValue(new Error('boom'));
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    await waitFor(() => nodeCount(renderer.root, 'QueryError') > 0);

    const queryError = findNode(renderer.root, 'QueryError');
    expect(queryError?.props.title).toBe('Could not load accounts');
    expect(typeof queryError?.props.onRetry).toBe('function');
    expectAlignedContent(renderer.root);

    unmount();
  });

  it('does not fire the queries when unauthenticated', async () => {
    authState.token = null;

    const { renderer, unmount } = await mountProfile();

    await act(async () => {
      await Promise.resolve();
    });

    expect(providersQueryFn).not.toHaveBeenCalled();
    expect(organizationsQueryFn).not.toHaveBeenCalled();
    // No token: no section, no dangling header and no skeleton.
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);
    expect(nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts')).toBe(0);

    unmount();
  });

  it('re-fetches on mount so a cached providers error can recover', async () => {
    providersQueryFn
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ providers: [{ provider: 'github', email: 'dev@kilo.ai' }] });
    organizationsQueryFn.mockResolvedValue([]);

    const queryClient = createTestQueryClient();
    const first = await renderWithProviders(createElement(ProfileScreen), { queryClient });

    // Settle the first mount into the error state so the error is cached.
    await waitFor(() => nodeCount(first.renderer.root, 'QueryError') > 0);

    // Unmount without clearing the cache (the harness `unmount` clears it).
    act(() => {
      first.renderer.unmount();
    });

    const second = await renderWithProviders(createElement(ProfileScreen), { queryClient });

    // The mount fetch runs again and the row replaces the cached error.
    await waitFor(() => findConfigureRows(second.renderer.root, 'GitHub').length === 1);
    expect(providersQueryFn).toHaveBeenCalledTimes(2);
    expect(nodeCount(second.renderer.root, 'QueryError')).toBe(0);

    second.unmount();
  });

  it('renders the permanent Tutorial row and pushes the tour route unconditionally', async () => {
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    const rows = findConfigureRows(renderer.root, 'Tutorial');
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (!row) {
      throw new Error('Tutorial row was not rendered');
    }
    act(() => {
      (row.props as { onPress?: () => void }).onPress?.();
    });
    expect(routerPush).toHaveBeenCalledWith('/(app)/tour');

    unmount();
  });

  it('hides the linked-accounts section when the fetch settles empty', async () => {
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    // After the fetch settles empty: no skeleton and no header, and the agent
    // rows stop being held disabled.
    await waitFor(
      () =>
        nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts') === 0 &&
        nodeCount(renderer.root, 'Skeleton') === 0 &&
        getProfileAgentScopeMock.mock.calls.at(-1)?.[2] === false
    );

    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);
    expect(nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts')).toBe(0);
    expectAlignedContent(renderer.root);

    unmount();
  });
});
