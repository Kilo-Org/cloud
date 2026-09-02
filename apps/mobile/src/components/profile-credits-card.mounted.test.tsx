/* eslint-disable typescript-eslint/no-deprecated, max-lines -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Balance across owners: the card keeps the raw 2-element tRPC query key
// (`[path, { input, type }]`), never a userId-suffixed key. Owner switches are
// safe because sign-out clears the React Query cache (`queryClient.clear()`), so
// a new owner refetches and never reuses the previous owner's cached balance.

import { createElement, type ElementType } from 'react';
import { Platform, Pressable } from 'react-native';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { type QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { CreditsCard } from './profile-credits-card';
import { type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { OrganizationProvider } from '@/lib/organization-context';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

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

const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: storage.read,
  setItemAsync: storage.write,
  deleteItemAsync: storage.remove,
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => false,
}));

const showPicker = vi.hoisted(() => vi.fn());
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: showPicker }),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));

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

// ── Helpers ────────────────────────────────────────────────────────────────

const BALANCE_KEY = ['user', 'getContextBalance'] as const;
const organizationName = 'A very long organization name that must leave the credits label visible';
const savedMetadata = new Map<string, string>();
let saveCompletion: Promise<undefined> | undefined = undefined;

async function mountCard(
  queryClient: QueryClient = createTestQueryClient(),
  orgs?: OrgListEntry[]
) {
  const ui = await renderWithProviders(createElement(CreditsCard, { enabled: true, orgs }), {
    queryClient,
    wrapper: OrganizationProvider,
  });
  return {
    ...ui,
    texts: () =>
      ui.renderer.root
        .findAll(() => true)
        .flatMap(node => node.children.filter(child => typeof child === 'string')),
  };
}

function openNativePicker(renderer: ReactTestRenderer) {
  const control = renderer.root.find(
    node => node.type === Pressable && node.props.accessibilityHint === 'Select account'
  );
  const open = control.props.onPress as () => void;
  act(() => {
    open();
  });
  const call = showPicker.mock.lastCall as
    | [{ options: string[]; cancelButtonIndex: number }, (index: number) => void]
    | undefined;
  if (!call) {
    throw new Error('native picker did not open');
  }
  return call;
}

beforeEach(() => {
  Platform.OS = 'ios';
  savedMetadata.clear();
  saveCompletion = undefined;
  storage.read.mockReset().mockImplementation(async (key: string) => {
    await Promise.resolve();
    return savedMetadata.get(key) ?? null;
  });
  storage.write.mockReset().mockImplementation(async (key: string, value: string) => {
    await saveCompletion;
    savedMetadata.set(key, value);
  });
  storage.remove.mockReset().mockImplementation(async (key: string) => {
    await saveCompletion;
    savedMetadata.delete(key);
  });
  showPicker.mockReset();
  getContextBalanceQueryFn.mockReset();
  personalCreditBlocksQueryFn.mockReset();
  orgCreditBlocksQueryFn.mockReset();
  refetchUserId.mockReset();
  currentUser.userId = undefined;
  currentUser.isError = false;
  personalCreditBlocksQueryFn.mockResolvedValue({ creditBlocks: [] });
});

describe('CreditsCard balance state', () => {
  it.each([
    { orgs: [], options: ['Personal', 'Cancel'], choice: 0, expected: null, label: 'Personal' },
    {
      orgs: [{ organizationId: 'org-a', organizationName, role: 'owner' }],
      options: ['Personal', organizationName, 'Cancel'],
      choice: 1,
      expected: 'org-a',
      label: organizationName,
    },
  ])('uses supplied memberships for native selection: $expected', async state => {
    savedMetadata.set(ORGANIZATION_STORAGE_KEY, 'missing-org');
    const { renderer, texts, unmount } = await mountCard(
      createTestQueryClient(),
      state.orgs as OrgListEntry[]
    );
    const call = openNativePicker(renderer);
    expect(call[0].options).toEqual(state.options);
    await act(() => {
      call[1](call[0].cancelButtonIndex);
    });
    expect(savedMetadata.get(ORGANIZATION_STORAGE_KEY)).toBe('missing-org');
    expect(texts()).toContain('Organization');
    await act(() => {
      call[1](state.choice);
    });
    expect(savedMetadata.get(ORGANIZATION_STORAGE_KEY)).toBe(state.expected ?? undefined);
    const label = renderer.root.findByProps({ children: state.label });
    expect(label.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' });
    unmount();
  });

  it.each(['org-b', null])(
    'retries the latest Profile selection %s after save failures',
    async id => {
      Platform.OS = 'android';
      savedMetadata.set(ORGANIZATION_STORAGE_KEY, 'previous-org');
      const orgs = [
        { organizationId: 'org-a', organizationName: 'Supplied organization', role: 'owner' },
        { organizationId: 'org-b', organizationName: 'Latest organization', role: 'owner' },
      ] as OrgListEntry[];
      storage.write.mockRejectedValueOnce(new Error('write failed'));
      const { renderer, texts, unmount } = await mountCard(createTestQueryClient(), orgs);
      const firstPicker = openNativePicker(renderer);
      await act(() => {
        firstPicker[1](1);
      });
      expect(texts()).toContain('Could not save setting');
      expect(texts()).toContain('Supplied organization');
      expect(savedMetadata.get(ORGANIZATION_STORAGE_KEY)).toBe('previous-org');
      const retryButton = renderer.root.findByProps({ accessibilityLabel: 'Retry' });
      expect(retryButton.props.accessibilityRole).toBe('button');
      expect(retryButton.props.accessibilityHint).toBe('Could not save setting');
      // Keep the rendered handler to catch a retry that captures the earlier failed choice.
      const retry = retryButton.props.onPress as () => void;
      (id === null ? storage.remove : storage.write).mockRejectedValueOnce(
        new Error('latest save failed')
      );
      const latestPicker = openNativePicker(renderer);
      await act(() => {
        latestPicker[1](id === null ? 0 : 2);
      });
      const label = id === null ? 'Personal' : 'Latest organization';
      expect(texts()).toContain(label);
      expect(savedMetadata.get(ORGANIZATION_STORAGE_KEY)).toBe('previous-org');
      const status = renderer.root.find(
        node => (node.type as string) === 'Text' && node.props.accessibilityLiveRegion === 'polite'
      );
      expect(status.children).toContain('Could not save setting');
      const save = Promise.withResolvers<undefined>();
      saveCompletion = save.promise;
      await act(() => {
        retry();
      });
      expect(texts()).toContain(label);
      expect(texts()).toContain('Could not save setting');
      const busyRetry = renderer.root.findByProps({ accessibilityLabel: 'Retry' });
      expect(busyRetry.props.accessibilityState).toEqual({ busy: true, disabled: true });
      expect(busyRetry.props.disabled).toBe(true);
      expect(busyRetry.findAllByType('ActivityIndicator' as ElementType)).toHaveLength(1);
      expect(savedMetadata.get(ORGANIZATION_STORAGE_KEY)).toBe('previous-org');
      await act(() => {
        save.resolve(undefined);
      });
      expect(savedMetadata.get(ORGANIZATION_STORAGE_KEY)).toBe(id ?? undefined);
      expect(texts()).toContain(label);
      expect(texts()).not.toContain('Could not save setting');
      expect(texts()).not.toContain('Retry');
      unmount();
      const reopened = await mountCard(createTestQueryClient(), orgs);
      expect(reopened.texts()).toContain(label);
      reopened.unmount();
    }
  );

  it('shows a skeleton (not $0) when no signed-in user is resolved yet', async () => {
    const { texts, unmount } = await mountCard();

    expect(texts()).toContain('SKELETON');
    expect(texts()).not.toContain('ADD_CREDITS_ROW');
    expect(texts()).not.toContain('$0.00');

    unmount();
  });

  it('shows a cached balance without reusing it after an account change', async () => {
    const queryClient = createTestQueryClient();

    // Owner A signs in and has a cached balance.
    currentUser.userId = 'user-A';
    queryClient.setQueryData([...BALANCE_KEY], { balance: 10 });

    // Hold the next owner's balance fetch until the test resolves it, so the
    // skeleton state between the switch and the resolved fetch is observable.
    const balanceB = Promise.withResolvers<{ balance: number }>();
    getContextBalanceQueryFn.mockReturnValue(balanceB.promise);

    const a = await mountCard(queryClient);

    // User A renders from cache.
    await waitFor(() => a.texts().includes('$10.00'));
    expect(a.texts()).toContain('$10.00');
    expect(a.texts()).not.toContain('SKELETON');

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
    await act(() => {
      balanceB.resolve({ balance: 25 });
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
