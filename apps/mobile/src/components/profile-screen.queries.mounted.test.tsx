import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import {
  advanceUntil,
  authState,
  findConfigureRows,
  findNode,
  flushInteractions,
  getProfileAgentScopeMock,
  interactionState,
  keys,
  mountProfile,
  nodeCount,
  nodeCountWithChildren,
  organizationsQueryFn,
  providersQueryFn,
  routerPush,
  signOutFn,
} from '@/components/profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { AFTER_INTERACTIONS_FALLBACK_MS } from '@/lib/hooks/use-after-interactions';
import { act, type ReactTestInstance } from '@/test/renderer';
import { createTestQueryClient, waitFor } from '@/test/render-with-providers';

// This spec is the only one that varies the safe-area insets, so it owns that
// mock instead of the shared harness.
const safeArea = vi.hoisted(() => ({ top: 24, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function expectAlignedContent(root: ReactTestInstance) {
  const scroll = findNode(root, 'ScrollView');
  expect.soft(scroll?.props.contentContainerClassName).toBe('px-4 pt-4');
  expect(scroll?.props.style).toEqual({ marginLeft: safeArea.left, marginRight: safeArea.right });
  expect(findNode(root, 'CreditsCard')?.parent).toBe(scroll);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProfileScreen deferred queries', () => {
  beforeEach(() => {
    vi.useRealTimers();
    providersQueryFn.mockReset();
    organizationsQueryFn.mockReset();
    signOutFn.mockReset();
    routerPush.mockReset();
    authState.token = 'token-1';
    interactionState.storedCallback = undefined;
    interactionState.cancel.mockReset();
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
    const { renderer, unmount } = await mountProfile();

    expectAlignedContent(renderer.root);

    unmount();
  });

  it('defers both queries until interactions settle, showing the skeleton first', async () => {
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    // Before the flush: neither query fired, the content-shaped skeleton
    // (icon tile + two text bars) shows, and the agent rows are held
    // disabled (refreshing argument is true).
    expect(providersQueryFn).not.toHaveBeenCalled();
    expect(organizationsQueryFn).not.toHaveBeenCalled();
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(3);
    expectAlignedContent(renderer.root);
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

  it('repro: renders the linked account when interactions never report idle', async () => {
    providersQueryFn.mockResolvedValue({
      providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
    });
    organizationsQueryFn.mockResolvedValue([]);

    vi.useFakeTimers();
    const { renderer, unmount } = await mountProfile();

    // The automated-session state: the callback captured by the
    // `runAfterInteractions` mock is never flushed, so the interaction queue
    // stays open and only the hook's fallback can release the gated queries.
    // Before the fix this mount stayed on the skeleton forever and the
    // signed-in address -- the only place the app renders it -- never
    // appeared.
    expect(providersQueryFn).not.toHaveBeenCalled();
    await advanceUntil(
      () => findConfigureRows(renderer.root, 'GitHub').length === 1,
      AFTER_INTERACTIONS_FALLBACK_MS * 4
    );
    vi.useRealTimers();

    expect(providersQueryFn).toHaveBeenCalledTimes(1);
    expect(findConfigureRows(renderer.root, 'GitHub')[0]?.props.subtitle).toBe('dev@kilo.ai');
    expect(nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts')).toBe(1);

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

    const { renderer, unmount } = await mountProfile(queryClient);

    expect(providersQueryFn).not.toHaveBeenCalled();
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);
    expect(renderer.root.findAllByProps({ title: 'GitHub' })).toHaveLength(1);
    expectAlignedContent(renderer.root);

    unmount();
  });

  it('gives every profile destination its documented row-palette hue', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(keys.providers, {
      providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
    });
    queryClient.setQueryData(keys.organizations, [
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
    ]);

    const { renderer, unmount } = await mountProfile(queryClient);
    const root = renderer.root;

    // The destination table from `agent-color.ts`: the hue identifies the row's
    // destination, so it is passed explicitly and never derived from the label.
    const expectRowHue = (title: string, hue: string) => {
      const rows = findConfigureRows(root, title);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.props.hue).toBe(hue);
    };
    expectRowHue(i18n.t('common.codeReviewer'), 'honey');
    expectRowHue(i18n.t('common.securityAgent'), 'honey');
    expectRowHue(i18n.t('common.prReview'), 'gold');
    expectRowHue(i18n.t('profile.manageOrganization'), 'lime');
    expectRowHue(i18n.t('common.preferences'), 'sage');
    expectRowHue(i18n.t('tour.tutorialLabel'), 'sage');
    expectRowHue('GitHub', 'moss');

    const actionTiles = root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ActionTile'
    );
    expect(actionTiles).toHaveLength(4);
    const hueByLabel = new Map(actionTiles.map(tile => [tile.props.label as string, tile]));
    expect(hueByLabel.get(i18n.t('profile.feedback'))?.props.hue).toBe('fern');
    expect(hueByLabel.get(i18n.t('profile.privacyChoices'))?.props.hue).toBe('fern');
    expect(hueByLabel.get(i18n.t('common.signOut'))?.props.hue).toBe('fern');

    // Delete account takes the same family step, and the danger tone still wins
    // inside ActionTile.
    const deleteAccount = hueByLabel.get(i18n.t('profile.deleteAccount'));
    expect(deleteAccount?.props.hue).toBe('fern');
    expect(deleteAccount?.props.destructive).toBe(true);

    unmount();
  });

  it('paints the linked account row without an entering animation once the providers load', async () => {
    providersQueryFn.mockResolvedValue({
      providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
    });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    flushInteractions();
    await waitFor(() => findConfigureRows(renderer.root, 'GitHub').length === 1);

    const row = findConfigureRows(renderer.root, 'GitHub')[0];
    if (!row) {
      throw new Error('GitHub row was not rendered');
    }

    // A Reanimated entering animation does not run while the app is
    // backgrounded: the row stays mounted at opacity 0, so the `Linked
    // accounts` header sits alone above the tab bar and the Actions section is
    // pushed out of the viewport. The row must be painted in the frame its data
    // arrives, with no ancestor holding an entering animation.
    const ancestorsWithEntering: string[] = [];
    for (let node = row.parent; node; node = node.parent) {
      if ('entering' in node.props) {
        ancestorsWithEntering.push(node.type as string);
      }
    }
    expect(ancestorsWithEntering).toEqual([]);

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
    expectAlignedContent(renderer.root);

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
    const first = await mountProfile(queryClient);

    // Settle the first mount into the error state so the error is cached.
    flushInteractions();
    await waitFor(() => nodeCount(first.renderer.root, 'QueryError') > 0);

    // Unmount without clearing the cache (the harness `unmount` clears it).
    act(() => {
      first.renderer.unmount();
    });

    // The error is now cached; reset the call history so a refire is observable.
    providersQueryFn.mockClear();

    const second = await mountProfile(queryClient);

    // Before the flush: the cached error renders, no skeleton, and no refire.
    expect(nodeCount(second.renderer.root, 'QueryError')).toBe(1);
    expect(nodeCount(second.renderer.root, 'Skeleton')).toBe(0);
    expect(providersQueryFn).not.toHaveBeenCalled();

    second.unmount();
  });

  it('renders the permanent Tutorial row and pushes the tour route unconditionally', async () => {
    providersQueryFn.mockResolvedValue({ providers: [] });
    organizationsQueryFn.mockResolvedValue([]);

    const { renderer, unmount } = await mountProfile();

    const rows = renderer.root.findAllByProps({ title: 'Tutorial' });
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
    expectAlignedContent(renderer.root);

    unmount();
  });
});
