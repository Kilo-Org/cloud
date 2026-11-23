import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiscordMembershipRow } from '@/components/profile-discord-membership';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';
import { act, type ReactTestInstance } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const guildStatusQueryFn = vi.hoisted(() => vi.fn());
const verifyMutationFn = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const keys = vi.hoisted(() => ({
  guildStatus: ['user', 'getDiscordGuildStatus'],
  providers: ['user', 'getAuthProviders'],
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getDiscordGuildStatus: {
        queryOptions: () => ({ queryKey: keys.guildStatus, queryFn: guildStatusQueryFn }),
        queryKey: () => keys.guildStatus,
      },
      getAuthProviders: {
        queryKey: () => keys.providers,
      },
      verifyDiscordGuildMembership: {
        // The real `mutationOptions` merges the caller's callbacks into the
        // generated options, so the row's `onSuccess` runs the invalidations.
        mutationOptions: (options: { onSuccess?: () => void }) => ({
          mutationFn: verifyMutationFn,
          ...options,
        }),
      },
    },
  }),
}));

// The row is the unit under test: the grouped row and the loading placeholder
// are host markers, so the suite reads the row's own props instead of the
// primitives' internals.
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/icons', () => ({ Shield: 'Shield', ShieldCheck: 'ShieldCheck' }));
// The trailing cell's geometry belongs to the primitive; here the cell is its
// spec, which is exactly what the row hands it: a text action and its handler.
vi.mock('@/components/ui/row-trailing', () => ({
  renderRowTrailing: (spec: Record<string, unknown>) => createElement('RowTrailing', spec),
}));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: vi.fn() }));

// ── Helpers ────────────────────────────────────────────────────────────────

const VERIFIED_AT = '2026-03-04T10:00:00.000Z';

type TrailingAction = Readonly<{
  kind: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityState?: { busy?: boolean };
}>;

function rowNode(root: ReactTestInstance): ReactTestInstance {
  const [row] = root.findAll(node => String(node.type) === 'ConfigureRow');
  if (!row) {
    throw new Error('the Discord membership row is not rendered');
  }
  return row;
}

/** The settled row's title, or undefined while the row is still its placeholder. */
function rowTitle(root: ReactTestInstance): string | undefined {
  const [row] = root.findAll(node => String(node.type) === 'ConfigureRow');
  return row === undefined ? undefined : String(row.props.title);
}

/** The settled row's subtitle, or undefined while the row is still its placeholder. */
function rowSubtitle(root: ReactTestInstance): string | undefined {
  const [row] = root.findAll(node => String(node.type) === 'ConfigureRow');
  const subtitle = row?.props.subtitle;
  return typeof subtitle === 'string' ? subtitle : undefined;
}

function trailingAction(root: ReactTestInstance): ReactElement<TrailingAction> {
  const trailing = rowNode(root).props.trailing as ReactElement<TrailingAction> | undefined;
  if (!trailing) {
    throw new Error('the Discord membership row renders no action');
  }
  return trailing;
}

function guildStatus(verifiedAt: string | null) {
  return {
    success: true as const,
    linked: true,
    discord_avatar_url: null,
    discord_display_name: null,
    discord_server_membership_verified_at: verifiedAt,
  };
}

function mountRow(
  props: Partial<{
    isAuthenticated: boolean;
    afterIdle: boolean;
    hasDiscordLinked: boolean;
  }> = {}
) {
  return renderWithProviders(
    createElement(DiscordMembershipRow, {
      isAuthenticated: true,
      afterIdle: true,
      hasDiscordLinked: true,
      ...props,
    }),
    { queryClient: createTestQueryClient() }
  );
}

/** Press the row's trailing text action, as a tap on it does. */
async function pressTrailing(root: ReactTestInstance) {
  const action = trailingAction(root);
  await act(async () => {
    action.props.onPress();
    await Promise.resolve();
  });
}

beforeEach(() => {
  guildStatusQueryFn.mockReset();
  verifyMutationFn.mockReset();
  routerPush.mockReset();
});

afterEach(async () => {
  if (i18n.language !== 'en') {
    await i18n.changeLanguage('en');
  }
});

describe('DiscordMembershipRow', () => {
  it('offers the way to link Discord without asking the server for a membership', async () => {
    guildStatusQueryFn.mockResolvedValue(guildStatus(null));

    const { renderer, unmount } = await mountRow({ hasDiscordLinked: false });

    // The status read is gated on a linked provider, so a state the row already
    // knows costs no request and reserves no loading placeholder.
    await act(async () => {
      await Promise.resolve();
    });
    expect(guildStatusQueryFn).not.toHaveBeenCalled();
    expect(renderer.root.findAll(node => String(node.type) === 'RowSkeleton')).toHaveLength(0);

    const row = rowNode(renderer.root);
    expect(row.props.title).toBe(i18n.t('profile.discord.title'));
    expect(row.props.subtitle).toBe(i18n.t('profile.discord.linkPrompt'));
    expect(row.props.testID).toBe('discord-membership-row');

    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(routerPush).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/login-methods');

    unmount();
  });

  it('reports the verified date in the app language', async () => {
    await i18n.changeLanguage('de');
    guildStatusQueryFn.mockResolvedValue(guildStatus(VERIFIED_AT));

    const { renderer, unmount } = await mountRow();

    await waitFor(() => rowTitle(renderer.root) === i18n.t('profile.discord.memberTitle'));

    const row = rowNode(renderer.root);
    const germanDate = formatDate(parseTimestamp(VERIFIED_AT), 'de');
    const englishDate = formatDate(parseTimestamp(VERIFIED_AT), 'en');
    expect(germanDate).not.toBe(englishDate);
    // The catalog sentence carries the locale's own date, not a pinned one.
    expect(row.props.subtitle).toBe(i18n.t('profile.discord.memberSubtitle', { date: germanDate }));
    expect(row.props.subtitle).toContain(germanDate);
    expect(row.props.subtitle).not.toContain(englishDate);
    // A verified membership has nothing left to act on.
    expect(row.props.trailing).toBeUndefined();

    unmount();
  });

  it('verifies a non-member and re-reads the stored membership', async () => {
    guildStatusQueryFn.mockResolvedValue(guildStatus(null));
    verifyMutationFn.mockResolvedValue({ success: true, is_member: true });

    const { renderer, unmount } = await mountRow();

    await waitFor(() => rowTitle(renderer.root) === i18n.t('profile.discord.notMemberTitle'));
    expect(trailingAction(renderer.root).props.kind).toBe('action');
    expect(trailingAction(renderer.root).props.label).toBe(i18n.t('profile.discord.verify'));
    expect(trailingAction(renderer.root).props.disabled).toBe(false);

    await pressTrailing(renderer.root);

    expect(verifyMutationFn).toHaveBeenCalledTimes(1);
    // The stored verification is the server's answer: the row re-reads it.
    await waitFor(() => guildStatusQueryFn.mock.calls.length === 2);

    unmount();
  });

  it('keeps the last membership state and shows the failure when a verify fails', async () => {
    guildStatusQueryFn.mockResolvedValue(guildStatus(null));
    verifyMutationFn.mockRejectedValue(new Error('verify failed'));

    const { renderer, unmount } = await mountRow();

    await waitFor(() => rowTitle(renderer.root) === i18n.t('profile.discord.notMemberTitle'));

    await pressTrailing(renderer.root);

    await waitFor(() => rowSubtitle(renderer.root) === i18n.t('profile.discord.verifyFailed'));
    const row = rowNode(renderer.root);
    // The failure is the row's one message: the row neither claims membership
    // nor loses the state it already reported.
    expect(row.props.title).toBe(i18n.t('profile.discord.notMemberTitle'));
    expect(row.props.subtitle).toBe(i18n.t('profile.discord.verifyFailed'));
    expect(renderer.root.findAll(node => String(node.type) === 'ConfigureRow')).toHaveLength(1);

    // No pending marker outlives the attempt, and the action is free to retry.
    const action = trailingAction(renderer.root);
    expect(action.props.label).toBe(i18n.t('profile.discord.reverify'));
    expect(action.props.disabled).toBe(false);
    expect(action.props.accessibilityState).toBeUndefined();

    await pressTrailing(renderer.root);
    expect(verifyMutationFn).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('shows the load failure and retries the membership read', async () => {
    guildStatusQueryFn.mockRejectedValue(new Error('membership read failed'));

    const { renderer, unmount } = await mountRow();

    await waitFor(() => rowSubtitle(renderer.root) === i18n.t('profile.discord.loadFailed'));
    const row = rowNode(renderer.root);
    expect(row.props.title).toBe(i18n.t('profile.discord.title'));
    expect(trailingAction(renderer.root).props.label).toBe(i18n.t('common.retry'));

    await pressTrailing(renderer.root);

    await waitFor(() => guildStatusQueryFn.mock.calls.length === 2);

    unmount();
  });
});
