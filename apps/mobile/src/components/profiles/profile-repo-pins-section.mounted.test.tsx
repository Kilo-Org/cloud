/* eslint-disable max-lines -- one mounted suite pins the card's skeleton, both error classifications, rows, pin and unbind */
import { QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfileRepoPinsSection } from '@/components/profiles/profile-repo-pins-section';
import {
  SECTION_ACTION_BOX_CLASS,
  SECTION_ACTION_FRAME_DP,
  SECTION_ACTION_HIT_SLOP,
  SECTION_ACTION_HIT_SLOP_DP,
  tapTargetReachDp,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

type TestBinding = {
  repoFullName: string;
  platform: string;
  profileId: string;
  profileName: string;
};
type TestRepoOption = { platform: 'github' | 'gitlab'; fullName: string; private: boolean };

/** The props the mocked `QueryError` host element carries; the renderer keeps them untyped. */
type RenderedQueryError = {
  variant?: string;
  title?: string;
  message?: string;
  onRetry?: () => void;
};

const h = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  connectivity: 'online' as string,
  bindingsQuery: {
    bindings: [] as TestBinding[],
    error: undefined as unknown,
    isLoading: true,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    bind: { mutateAsync: vi.fn(), isPending: false },
    unbind: { mutateAsync: vi.fn(), isPending: false },
  },
  repoOptions: {
    repositories: [] as TestRepoOption[],
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    isRefetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@/lib/hooks/use-repo-bindings', () => ({
  useRepoBindings: () => h.bindingsQuery,
  useRepoBindingMutations: () => h.mutations,
  useRepoOptions: () => h.repoOptions,
}));
vi.mock('sonner-native', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => h.connectivity,
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
}));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => undefined },
  Platform: { OS: 'ios' },
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  I18nManager: { isRTL: false },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000000',
    destructive: '#FF0000',
    primary: '#0000FF',
    foreground: '#111111',
  }),
}));
// The repo picker sheet opens Connected services through the router; the real
// `expo-router` entry cannot load in this project, so the suite stubs the one
// hook the sheet calls.
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  EYEBROW_LATIN_DISPLAY: '',
  EYEBROW_LINE_HEIGHT_DP: 22,
}));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  GitBranch: 'GitBranch',
  Link2: 'Link2',
  Lock: 'Lock',
  Plus: 'Plus',
  Search: 'Search',
  SearchX: 'SearchX',
  Trash2: 'Trash2',
  Unlock: 'Unlock',
}));

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function pressPressable(root: ReactTestInstance, label: string): void {
  const pressable = findAll(root, 'Pressable').find(
    node => node.props.accessibilityLabel === label
  );
  if (!pressable) {
    throw new Error(`pressable ${label} was not rendered`);
  }
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSection(organizationId?: string, canManage = true) {
  return renderWithProviders(
    createElement(ProfileRepoPinsSection, { profileId: 'profile-1', organizationId, canManage })
  );
}

describe('ProfileRepoPinsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.connectivity = 'online';
    Object.assign(h.bindingsQuery, {
      bindings: [],
      error: undefined,
      isLoading: true,
      isError: false,
      isRefetching: false,
    });
    Object.assign(h.mutations.bind, { isPending: false });
    Object.assign(h.mutations.unbind, { isPending: false });
    Object.assign(h.repoOptions, {
      repositories: [
        { platform: 'github', fullName: 'acme/api', private: true },
        { platform: 'gitlab', fullName: 'acme/infra', private: false },
      ],
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
  });

  it('loading: renders the card skeleton', async () => {
    const { renderer, unmount } = await mountSection();
    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    unmount();
  });

  it('retryable: a bindings failure shows QueryError and Retry refetches', async () => {
    Object.assign(h.bindingsQuery, {
      isError: true,
      isLoading: false,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
    const { renderer, unmount } = await mountSection();

    // The renderer keeps host props untyped; the stub's props are the screen's own.
    const queryError = findAll(renderer.root, 'QueryError')[0]?.props as
      | RenderedQueryError
      | undefined;
    if (!queryError) {
      throw new Error('QueryError was not rendered');
    }
    expect(queryError.variant).toBe('server');
    expect(queryError.title).toBe("Couldn't load profiles");
    act(() => {
      queryError.onRetry?.();
    });
    expect(h.bindingsQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('forbidden: names the permission state and offers no Retry', async () => {
    Object.assign(h.bindingsQuery, {
      isError: true,
      isLoading: false,
      error: { data: { code: 'FORBIDDEN' } },
    });
    const { renderer, unmount } = await mountSection();

    const queryError = findAll(renderer.root, 'QueryError')[0]?.props as
      | RenderedQueryError
      | undefined;
    expect(queryError?.variant).toBe('permission');
    expect(queryError?.title).toBeUndefined();
    // The permission state names who can grant access instead of repeating its
    // own title.
    expect(queryError?.message).toBe('Ask an organization owner or admin to grant you access.');
    expect(queryError?.onRetry).toBeUndefined();
    unmount();
  });

  it('forbidden: withholds the Pin a repo action on a terminal read', async () => {
    Object.assign(h.bindingsQuery, {
      isError: true,
      isLoading: false,
      error: { data: { code: 'FORBIDDEN' } },
    });
    const { renderer, unmount } = await mountSection();

    // The section names a read failure, so it must not offer the write the
    // failed read was going to show.
    expect(
      findAll(renderer.root, 'Pressable').some(
        node => node.props.accessibilityLabel === 'Pin a repo'
      )
    ).toBe(false);

    unmount();
  });

  it('offline: keeps the load-failure title and a Retry that refetches', async () => {
    h.connectivity = 'offline';
    Object.assign(h.bindingsQuery, {
      isError: true,
      isLoading: false,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
    const { renderer, unmount } = await mountSection();

    const queryError = findAll(renderer.root, 'QueryError')[0]?.props as
      | RenderedQueryError
      | undefined;
    expect(queryError?.variant).toBe('offline');
    expect(queryError?.title).toBe("Couldn't load profiles");
    expect(typeof queryError?.onRetry).toBe('function');
    act(() => {
      queryError?.onRetry?.();
    });
    expect(h.bindingsQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('empty: shows Not pinned to any repositories.', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });
    const { renderer, unmount } = await mountSection();
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      'Not pinned to any repositories.'
    );
    unmount();
  });

  it('happy: lists only this profile’s bindings and unbinds one', async () => {
    Object.assign(h.bindingsQuery, {
      isLoading: false,
      bindings: [
        {
          repoFullName: 'acme/api',
          platform: 'github',
          profileId: 'profile-1',
          profileName: 'Mine',
        },
        {
          repoFullName: 'acme/other',
          platform: 'github',
          profileId: 'profile-2',
          profileName: 'Theirs',
        },
      ],
    });
    h.mutations.unbind.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountSection();

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('acme/api');
    expect(texts).not.toContain('acme/other');

    pressPressable(renderer.root, 'Unbind acme/api');
    await waitFor(() => h.mutations.unbind.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.unbind.mutateAsync.mock.calls[0]?.[0]).toEqual({
      repoFullName: 'acme/api',
      platform: 'github',
    });

    unmount();
  });

  it('happy: Pin a repo binds the picked repo to this profile', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });
    h.mutations.bind.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountSection();
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);
    pressPressable(renderer.root, 'Pin a repo');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);
    pressPressable(renderer.root, 'acme/infra');

    await waitFor(() => h.mutations.bind.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.bind.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      repoFullName: 'acme/infra',
      platform: 'gitlab',
    });

    unmount();
  });

  it('closes the pin sheet when the read turns terminal under it', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });

    const { renderer, queryClient, unmount } = await mountSection();
    pressPressable(renderer.root, 'Pin a repo');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);

    // The same read now answers terminally, so the sheet it opened closes with
    // it; leaving the state set would reopen it without a tap once the key
    // answered successfully again.
    Object.assign(h.bindingsQuery, { isError: true, error: { data: { code: 'FORBIDDEN' } } });
    await act(async () => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProfileRepoPinsSection, { profileId: 'profile-1', canManage: true })
        )
      );
      await Promise.resolve();
    });
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);

    Object.assign(h.bindingsQuery, { isError: false, error: undefined });
    await act(async () => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProfileRepoPinsSection, { profileId: 'profile-1', canManage: true })
        )
      );
      await Promise.resolve();
    });
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);

    unmount();
  });

  it('closes the pin sheet when the manage permission goes away', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });

    const { renderer, queryClient, unmount } = await mountSection();
    pressPressable(renderer.root, 'Pin a repo');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);

    // The server refuses an organization bind without the manage role, so the
    // sheet closes with the permission that offered it instead of staying up
    // over a slot that no longer offers the action.
    const rerenderWith = async (canManage: boolean) => {
      await act(async () => {
        renderer.update(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ProfileRepoPinsSection, { profileId: 'profile-1', canManage })
          )
        );
        await Promise.resolve();
      });
    };

    await rerenderWith(false);
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);
    expect(
      findAll(renderer.root, 'Pressable').some(
        node => node.props.accessibilityLabel === 'Pin a repo'
      )
    ).toBe(false);

    // The state closed with the permission, so a restored role shows the action
    // again without reopening the sheet the tap once opened.
    await rerenderWith(true);
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);

    unmount();
  });

  it('compact: the pin action rides the section header box, so the header stays one line', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });

    const { renderer, unmount } = await mountSection();

    const action = findAll(renderer.root, 'Pressable').find(
      node => node.props.accessibilityLabel === 'Pin a repo'
    );
    if (!action) {
      throw new Error('the pin action was not rendered');
    }
    // The action is the section header's own box: its negative margins cancel
    // the 28dp frame back to the one text line it sits on, so the card never
    // grows a second line for it.
    const actionClasses = String(action.props.className).split(/\s+/);
    for (const token of SECTION_ACTION_BOX_CLASS.split(' ')) {
      expect(actionClasses).toContain(token);
    }
    expect(action.props.hitSlop).toEqual(SECTION_ACTION_HIT_SLOP);
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityState).toBeUndefined();
    // The declared reach clears the design target, and the box is symmetric
    // about the label's line, so the row keeps its height either way.
    expect(
      tapTargetReachDp(SECTION_ACTION_FRAME_DP, SECTION_ACTION_HIT_SLOP_DP)
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);

    unmount();
  });

  it('names each pinned row and its own unbind control', async () => {
    Object.assign(h.bindingsQuery, {
      isLoading: false,
      bindings: [
        {
          repoFullName: 'acme/api',
          platform: 'github',
          profileId: 'profile-1',
          profileName: 'Mine',
        },
        {
          repoFullName: 'acme/infra',
          platform: 'gitlab',
          profileId: 'profile-1',
          profileName: 'Mine',
        },
      ],
    });

    const { renderer, unmount } = await mountSection();

    expect(
      findAll(renderer.root, 'View')
        .filter(node => node.props.accessibilityRole === 'text' && node.props.accessible === true)
        .map(node => node.props.accessibilityLabel)
    ).toEqual(['acme/api, GitHub', 'acme/infra, GitLab']);
    // The header's own action leads the rows it sits above.
    expect(
      findAll(renderer.root, 'Pressable')
        .filter(node => node.props.accessibilityRole === 'button')
        .map(node => node.props.accessibilityLabel)
    ).toEqual(['Pin a repo', 'Unbind acme/api', 'Unbind acme/infra']);

    unmount();
  });

  it('read-only: keeps existing repository bindings without change controls', async () => {
    Object.assign(h.bindingsQuery, {
      isLoading: false,
      bindings: [
        {
          repoFullName: 'acme/api',
          platform: 'github',
          profileId: 'profile-1',
          profileName: 'Mine',
        },
      ],
    });

    const { renderer, unmount } = await mountSection('org-1', false);

    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain('acme/api');
    expect(
      findAll(renderer.root, 'Pressable').filter(node => node.props.accessibilityRole === 'button')
    ).toHaveLength(0);
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);

    unmount();
  });
});
