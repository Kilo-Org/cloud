import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { LoginMethodsScreen } from './login-methods-screen';
import type * as ReactQuery from '@tanstack/react-query';

type ConfirmOptions = { title: string; onConfirm: () => void };
type MutationOptions = {
  onSuccess?: (result: unknown, input: { provider: string }) => void;
  onError?: (error: Error) => void;
};

const state = vi.hoisted(() => ({
  providers: [] as { provider: string; email: string }[],
  error: false,
  confirm: vi.fn(),
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: { providers: state.providers },
      isPending: false,
      isError: state.error,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useMutation: (options: MutationOptions) => {
      state.mutations.push(options);
      return { mutate: state.mutate, isPending: false };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: state.confirm, dialog: null }),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: state.openExternalUrl }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.test' }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getAuthProviders: { queryOptions: () => ({}), queryKey: () => [] },
      unlinkAuthProvider: { mutationOptions: (options: MutationOptions) => options },
    },
  }),
}));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound', Plus: 'Plus' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));

const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(LoginMethodsScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function unlinkButtons(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, BUTTON) && node.props.accessibilityLabel);
}

function lastConfirm(): ConfirmOptions {
  const call = state.confirm.mock.calls.at(-1)?.[0] as ConfirmOptions | undefined;
  if (!call) {
    throw new Error('confirm was never asked');
  }
  return call;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.providers = [
    { provider: 'github', email: 'ada@example.test' },
    { provider: 'google', email: 'ada@example.test' },
  ];
  state.error = false;
  state.mutations = [];
  state.mutate.mockClear();
  state.confirm.mockClear();
  state.openExternalUrl.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('LoginMethodsScreen', () => {
  it('lists every linked method with its provider name', async () => {
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children)
    ).toEqual(expect.arrayContaining(['GitHub', 'Google', 'ada@example.test']));
  });

  it('asks before unlinking and then sends the provider', async () => {
    const root = await mount();
    const [github] = unlinkButtons(root);
    if (!github) {
      throw new Error('missing GitHub unlink button');
    }

    act(() => {
      (github.props.onPress as () => void)();
    });

    expect(lastConfirm().title).toBe('Unlink GitHub?');
    expect(state.mutate).not.toHaveBeenCalled();

    act(() => {
      lastConfirm().onConfirm();
    });
    expect(state.mutate).toHaveBeenCalledWith({ provider: 'github' });
  });

  it('reports the server rule for the last method beside the list', async () => {
    state.providers = [{ provider: 'github', email: 'ada@example.test' }];
    const root = await mount();

    act(() => {
      state.mutations[0]?.onError?.(new Error('You must keep at least one sign-in method'));
    });

    const status = root.findAll(node => Object.is(node.type, 'AccessibleStatus'));
    expect(status.map(node => node.props.message)).toEqual([
      'You must keep at least one sign-in method',
    ]);
  });

  it('opens the connected accounts page to link another provider', async () => {
    const root = await mount();
    const linkRow = root.findAll(
      node => Object.is(node.type, 'ConfigureRow') && node.props.title === 'Link another provider'
    );

    const [firstRow] = linkRow;
    if (!firstRow) {
      throw new Error('missing link-another-provider row');
    }
    act(() => {
      (firstRow.props.onPress as () => void)();
    });

    expect(state.openExternalUrl).toHaveBeenCalledWith(
      'https://app.example.test/connected-accounts',
      expect.objectContaining({ retryOnError: true })
    );
  });

  it('shows the empty state when no method is linked', async () => {
    state.providers = [];
    const root = await mount();

    const empty = root.findAll(node => Object.is(node.type, 'EmptyState'));
    expect(empty.map(node => node.props.title)).toEqual(['No sign-in methods']);
  });

  it('keeps a retry when the methods cannot be read', async () => {
    state.error = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });
});
