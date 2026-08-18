/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Paused-query regression: a paused balance query (offline/unknown
// connectivity, empty cache) is pending but not fetching, so `isLoading` is
// false while `balance` is still undefined. The card must show a skeleton,
// not `$0` / the AddCreditsRow CTA, on a cold launch before NetInfo settles.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CreditsCard } from './profile-credits-card';

const balanceQuery = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (value: unknown) => value,
  useQuery: () => balanceQuery,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getContextBalance: { queryOptions: () => ({}) },
      getCreditBlocks: { queryOptions: () => ({}) },
    },
    organizations: {
      getCreditBlocks: { queryOptions: () => ({}) },
    },
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
  formatDate: () => 'date',
  parseTimestamp: () => new Date(0),
}));

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

async function renderCard(): Promise<string[]> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(CreditsCard, { enabled: true, orgs: undefined })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return collectText(renderer.toJSON());
}

beforeEach(() => {
  balanceQuery.data = undefined;
  balanceQuery.isLoading = false;
  balanceQuery.isFetching = false;
  balanceQuery.isError = false;
  balanceQuery.refetch.mockClear();
});

describe('CreditsCard balance state', () => {
  it('shows a skeleton (not $0) when the balance query is paused with no data', async () => {
    const texts = await renderCard();

    expect(texts).toContain('SKELETON');
    expect(texts).not.toContain('ADD_CREDITS_ROW');
    expect(texts).not.toContain('$0.00');
  });

  it('shows the balance when data is present', async () => {
    balanceQuery.data = { balance: 1, creditBlocks: [] };

    const texts = await renderCard();

    expect(texts).not.toContain('SKELETON');
    expect(texts).toContain('$1.00');
  });
});
