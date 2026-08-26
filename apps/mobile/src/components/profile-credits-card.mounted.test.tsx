/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Balance across owners: the card keeps the raw 2-element tRPC query key
// (`[path, { input, type }]`), never a userId-suffixed key. Owner switches are
// safe because sign-out clears the React Query cache (`queryClient.clear()`), so
// a new owner refetches and never reuses the previous owner's cached balance.

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
    queryClient.setQueryData([...BALANCE_KEY], { balance: 1 });

    const { texts, unmount } = await mountCard(queryClient);

    await waitFor(() => texts().includes('$1.00') && !texts().includes('SKELETON'));
    expect(texts()).not.toContain('SKELETON');
    expect(texts()).toContain('$1.00');

    unmount();
  });

  it('never renders user A balance as current after switching to user B', async () => {
    const queryClient = createTestQueryClient();

    // Owner A signs in and has a cached balance.
    currentUser.userId = 'user-A';
    queryClient.setQueryData([...BALANCE_KEY], { balance: 10 });

    // Hold the next owner's balance fetch until the test resolves it, so the
    // skeleton state between the switch and the resolved fetch is observable.
    let resolveB: ((value: { balance: number }) => void) | undefined = undefined;
    getContextBalanceQueryFn.mockReturnValue(
      new Promise<{ balance: number }>(resolve => {
        resolveB = resolve;
      })
    );

    const a = await mountCard(queryClient);

    // User A renders from cache.
    await waitFor(() => a.texts().includes('$10.00'));
    expect(a.texts()).toContain('$10.00');

    // Sign-out unmounts the profile and clears the React Query cache.
    a.unmount();

    // Owner B mounts with an empty cache and must refetch.
    currentUser.userId = 'user-B';
    const b = await mountCard(queryClient);

    // B must never reuse A's cache: show the skeleton while B's fetch is in
    // flight, and A's dollars must never appear as the current amount.
    expect(b.texts()).toContain('SKELETON');
    expect(b.texts()).not.toContain('$10.00');

    // Resolve user B's balance.
    await act(async () => {
      resolveB?.({ balance: 25 });
      await Promise.resolve();
    });
    await waitFor(() => b.texts().includes('$25.00'));

    expect(b.texts()).toContain('$25.00');
    expect(b.texts()).not.toContain('$10.00');

    b.unmount();
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
