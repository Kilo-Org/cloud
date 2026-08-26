/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Owner-keyed financial queries: the balance card must never render one signed-in
// owner's cached balance as the current amount after the owner switches. Each
// query key is suffixed with the userId, and the placeholder gate compares the
// previous query key's last element against the current userId, so a user switch
// shows the skeleton instead of reusing the previous owner's cache.

import { createElement, type ReactElement } from 'react';
import { Pressable } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { CreditsCard } from './profile-credits-card';
import { type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { createTestQueryClient, waitFor } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const getContextBalanceQueryFn = vi.hoisted(() => vi.fn());
const personalCreditBlocksQueryFn = vi.hoisted(() => vi.fn());
const orgCreditBlocksQueryFn = vi.hoisted(() => vi.fn());
const refetchUserId = vi.hoisted(() => vi.fn());
const currentUser = vi.hoisted(() => ({
  userId: undefined as string | undefined,
  isError: false,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getContextBalance: {
        queryOptions: () => ({
          queryKey: ['user', 'getContextBalance'] as const,
          queryFn: getContextBalanceQueryFn,
        }),
      },
      getCreditBlocks: {
        queryOptions: () => ({
          queryKey: ['user', 'getCreditBlocks'] as const,
          queryFn: personalCreditBlocksQueryFn,
        }),
      },
    },
    organizations: {
      getCreditBlocks: {
        queryOptions: () => ({
          queryKey: ['organizations', 'getCreditBlocks'] as const,
          queryFn: orgCreditBlocksQueryFn,
        }),
      },
    },
  }),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({
    userId: currentUser.userId,
    email: undefined,
    isLoading: false,
    isError: currentUser.isError,
    refetch: refetchUserId,
  }),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, setOrganizationId: vi.fn() }),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => false,
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: { duration: vi.fn() },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => 'SKELETON',
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/add-credits-row', () => ({
  AddCreditsRow: () => 'ADD_CREDITS_ROW',
}));

vi.mock('@/components/kilo-pass/kilo-pass-subscription-card', () => ({
  KiloPassSubscriptionCard: () => null,
}));

vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

vi.mock('@/lib/utils', () => ({
  parseTimestamp: () => new Date(0),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const BALANCE_KEY = ['user', 'getContextBalance'] as const;

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

function cardElement(orgs?: OrgListEntry[]): ReactElement {
  return createElement(CreditsCard, { enabled: true, orgs });
}

type CardHandle = {
  renderer: ReactTestRenderer;
  texts: () => string[];
  rerender: () => Promise<void>;
  unmount: () => void;
};

async function mountCard(queryClient: QueryClient = createTestQueryClient()): Promise<CardHandle> {
  const wrapper = (orgs: OrgListEntry[] | undefined) =>
    createElement(QueryClientProvider, { client: queryClient }, cardElement(orgs));

  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(wrapper(undefined));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }

  return {
    renderer,
    texts: () => collectText(renderer.toJSON()),
    // Toggling `orgs` (undefined <-> []) forces a re-render without changing
    // the visible tree (both render the personal context with no picker), so a
    // userId change read from the mocked hook is picked up by the queries.
    rerender: async () => {
      await act(async () => {
        renderer.update(wrapper([]));
        await Promise.resolve();
      });
    },
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
      queryClient.clear();
    },
  };
}

beforeEach(() => {
  getContextBalanceQueryFn.mockReset();
  personalCreditBlocksQueryFn.mockReset();
  orgCreditBlocksQueryFn.mockReset();
  refetchUserId.mockReset();
  currentUser.userId = undefined;
  currentUser.isError = false;
  personalCreditBlocksQueryFn.mockResolvedValue({ creditBlocks: [] });
});

describe('CreditsCard balance state', () => {
  it('shows a skeleton (not $0) when no signed-in user is resolved yet', async () => {
    const { texts, unmount } = await mountCard();

    expect(texts()).toContain('SKELETON');
    expect(texts()).not.toContain('ADD_CREDITS_ROW');
    expect(texts()).not.toContain('$0.00');

    unmount();
  });

  it('shows the balance when data is cached for the signed-in user', async () => {
    currentUser.userId = 'user-A';
    const queryClient = createTestQueryClient();
    queryClient.setQueryData([...BALANCE_KEY, 'user-A'], { balance: 1 });

    const { texts, unmount } = await mountCard(queryClient);

    await waitFor(() => texts().includes('$1.00') && !texts().includes('SKELETON'));
    expect(texts()).not.toContain('SKELETON');
    expect(texts()).toContain('$1.00');

    unmount();
  });

  it('never renders user A balance as current after switching to user B', async () => {
    currentUser.userId = 'user-A';
    const queryClient = createTestQueryClient();
    queryClient.setQueryData([...BALANCE_KEY, 'user-A'], { balance: 10 });

    // Hold user B's balance fetch until the test resolves it, so the skeleton
    // state between the switch and the resolved fetch is observable.
    let resolveB: ((value: { balance: number }) => void) | undefined = undefined;
    getContextBalanceQueryFn.mockReturnValue(
      new Promise<{ balance: number }>(resolve => {
        resolveB = resolve;
      })
    );

    const { texts, rerender, unmount } = await mountCard(queryClient);

    // User A renders from cache.
    await waitFor(() => texts().includes('$10.00'));
    expect(texts()).toContain('$10.00');

    // Switch the owner to user B, who has no cache.
    currentUser.userId = 'user-B';
    await rerender();

    // The placeholder gate must not reuse A's cache: show the skeleton, and A's
    // dollars must never appear as the current amount.
    expect(texts()).toContain('SKELETON');
    expect(texts()).not.toContain('$10.00');

    // Resolve user B's balance.
    await act(async () => {
      resolveB?.({ balance: 25 });
      await Promise.resolve();
    });
    await waitFor(() => texts().includes('$25.00'));

    expect(texts()).toContain('$25.00');
    expect(texts()).not.toContain('$10.00');

    unmount();
  });

  it('shows the failed-to-load-balance copy when getMe errors, and retries both', async () => {
    currentUser.isError = true;

    const { renderer, texts, unmount } = await mountCard();

    expect(texts()).toContain('Failed to load balance. Tap to retry.');

    const errorPressable = renderer.root.find(node => node.type === Pressable);
    await act(async () => {
      const onPress = errorPressable.props.onPress as () => void;
      onPress();
      await Promise.resolve();
    });

    expect(refetchUserId).toHaveBeenCalledTimes(1);
    expect(getContextBalanceQueryFn).toHaveBeenCalledTimes(1);

    unmount();
  });
});
