import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { BlockedPeopleScreen } from './blocked-people-screen';
import type * as ReactQuery from '@tanstack/react-query';

type MutationOptions = {
  onSuccess?: (result: unknown, input: { githubLogin: string }) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

type ScreenState = {
  blockedLogins: string[];
  mutedLogins: string[];
  error: boolean;
  mutations: Record<string, MutationOptions>;
  calls: { name: string; input: unknown }[];
  toastError: Mock;
};

const state = vi.hoisted((): ScreenState => ({
  blockedLogins: [],
  mutedLogins: [],
  error: false,
  mutations: {},
  calls: [],
  toastError: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: { blockedLogins: state.blockedLogins, mutedLogins: state.mutedLogins },
      isPending: false,
      isError: state.error,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useMutation: (options: { kind: string } & MutationOptions) => {
      state.mutations[options.kind] = options;
      return {
        mutate: (input: unknown) => {
          state.calls.push({ name: options.kind, input });
        },
        isPending: false,
      };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock('sonner-native', () => ({
  toast: { error: state.toastError, success: vi.fn() },
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      listHiddenUsers: { queryOptions: () => ({}), queryKey: () => [] },
      unblockUser: {
        mutationOptions: (options: MutationOptions) => ({ kind: 'unblock', ...options }),
      },
      unmuteUser: {
        mutationOptions: (options: MutationOptions) => ({ kind: 'unmute', ...options }),
      },
    },
  }),
}));
vi.mock('@/components/ui/icons', () => ({ Ban: 'Ban' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));

const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(BlockedPeopleScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function action(root: ReactTestRenderer['root'], label: string) {
  const found = root.findAll(
    node => Object.is(node.type, BUTTON) && node.props.accessibilityLabel === label
  );
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one ${label} action, found ${found.length}`);
  }
  return only;
}

function texts(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.blockedLogins = ['spammer'];
  state.mutedLogins = ['loudmouth'];
  state.error = false;
  state.mutations = {};
  state.calls = [];
  state.toastError.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('BlockedPeopleScreen', () => {
  it('separates blocked people from muted people', async () => {
    const root = await mount();

    expect(texts(root)).toEqual(
      expect.arrayContaining(['Blocked people', 'Muted people', 'spammer', 'loudmouth'])
    );
  });

  it('unblocks a login directly, without a confirmation', async () => {
    const root = await mount();

    act(() => {
      (action(root, 'Unblock spammer').props.onPress as () => void)();
    });

    expect(state.calls).toEqual([{ name: 'unblock', input: { githubLogin: 'spammer' } }]);
  });

  it('unmutes a login directly', async () => {
    const root = await mount();

    act(() => {
      (action(root, 'Unmute loudmouth').props.onPress as () => void)();
    });

    expect(state.calls).toEqual([{ name: 'unmute', input: { githubLogin: 'loudmouth' } }]);
  });

  it('shows the server message when a reveal is refused', async () => {
    await mount();

    act(() => {
      state.mutations.unblock?.onSettled?.();
      state.mutations.unblock?.onError?.(new Error('That account is no longer hidden'));
    });

    expect(state.toastError).toHaveBeenCalledWith('That account is no longer hidden');
  });

  it('has one empty state when nobody is hidden', async () => {
    state.blockedLogins = [];
    state.mutedLogins = [];
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual(['Nobody is hidden']);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });

  it('keeps a retry when the lists cannot be read', async () => {
    state.error = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });
});
