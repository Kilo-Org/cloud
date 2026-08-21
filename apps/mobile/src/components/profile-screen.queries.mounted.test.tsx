/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  Building2: 'Building2',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
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

async function mountProfile() {
  const result = await renderWithProviders(createElement(ProfileScreen));
  return result;
}

function flushInteractions() {
  const run = interactionState.storedCallback;
  if (!run) {
    throw new Error('runAfterInteractions callback was not captured');
  }
  act(() => {
    run();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProfileScreen deferred queries', () => {
  beforeEach(() => {
    providersQueryFn.mockReset();
    organizationsQueryFn.mockReset();
    signOutFn.mockReset();
    routerPush.mockReset();
    authState.token = 'token-1';
    interactionState.storedCallback = undefined;
    interactionState.cancel.mockReset();
    getProfileAgentScopeMock.mockReset();
    getProfileAgentScopeMock.mockReturnValue('personal');
  });

  it('defers both queries until interactions settle, showing the skeleton first', async () => {
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    // Before the flush: neither query fired, the skeleton shows, and the agent
    // rows are held disabled (refreshing argument is true).
    expect(providersQueryFn).not.toHaveBeenCalled();
    expect(organizationsQueryFn).not.toHaveBeenCalled();
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(1);
    expect(getProfileAgentScopeMock.mock.calls.at(-1)?.[2]).toBe(true);

    flushInteractions();

    await waitFor(
      () => providersQueryFn.mock.calls.length > 0 && organizationsQueryFn.mock.calls.length > 0
    );
    expect(providersQueryFn).toHaveBeenCalledTimes(1);
    expect(organizationsQueryFn).toHaveBeenCalledTimes(1);

    // Once the deferred fetch settles, the refreshing argument is false.
    await waitFor(() => getProfileAgentScopeMock.mock.calls.at(-1)?.[2] === false);

    unmount();
  });

  it('renders cached providers without the skeleton before the flush', async () => {
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

    expect(providersQueryFn).not.toHaveBeenCalled();
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);
    expect(findConfigureRows(renderer.root, 'GitHub').length).toBe(1);

    unmount();
  });

  it('renders QueryError with retry after the deferred providers query fails', async () => {
    providersQueryFn.mockRejectedValue(new Error('boom'));
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    flushInteractions();
    await waitFor(() => nodeCount(renderer.root, 'QueryError') > 0);

    const queryError = findNode(renderer.root, 'QueryError');
    expect(queryError?.props.title).toBe('Could not load accounts');
    expect(typeof queryError?.props.onRetry).toBe('function');

    unmount();
  });

  it('does not fire the queries when unauthenticated, even after the flush', async () => {
    authState.token = null;

    const { unmount } = await mountProfile();

    flushInteractions();
    await act(async () => {
      await Promise.resolve();
    });

    expect(providersQueryFn).not.toHaveBeenCalled();
    expect(organizationsQueryFn).not.toHaveBeenCalled();

    unmount();
  });

  it('cancels the interaction handle on unmount', async () => {
    const { unmount } = await mountProfile();

    expect(interactionState.cancel).not.toHaveBeenCalled();
    unmount();
    expect(interactionState.cancel).toHaveBeenCalledTimes(1);
  });

  it('renders a cached providers error without the skeleton or a refire before the flush', async () => {
    providersQueryFn.mockRejectedValue(new Error('boom'));
    organizationsQueryFn.mockResolvedValue([]);

    const queryClient = createTestQueryClient();
    const first = await renderWithProviders(createElement(ProfileScreen), { queryClient });

    // Settle the first mount into the error state so the error is cached.
    flushInteractions();
    await waitFor(() => nodeCount(first.renderer.root, 'QueryError') > 0);

    // Unmount without clearing the cache (the harness `unmount` clears it).
    act(() => {
      first.renderer.unmount();
    });

    // The error is now cached; reset the call history so a refire is observable.
    providersQueryFn.mockClear();

    const second = await renderWithProviders(createElement(ProfileScreen), { queryClient });

    // Before the flush: the cached error renders, no skeleton, and no refire.
    expect(nodeCount(second.renderer.root, 'QueryError')).toBe(1);
    expect(nodeCount(second.renderer.root, 'Skeleton')).toBe(0);
    expect(providersQueryFn).not.toHaveBeenCalled();

    second.unmount();
  });

  it('hides the linked-accounts section when the deferred fetch settles empty', async () => {
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    flushInteractions();
    await waitFor(
      () => providersQueryFn.mock.calls.length > 0 && organizationsQueryFn.mock.calls.length > 0
    );

    // After the deferred fetch settles empty: no skeleton and no header.
    await waitFor(
      () =>
        nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts') === 0 &&
        nodeCount(renderer.root, 'Skeleton') === 0
    );

    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);
    expect(nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts')).toBe(0);

    unmount();
  });
});
