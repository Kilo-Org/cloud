import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { LoginMethodsScreen } from './login-methods-screen';
import type * as ReactQuery from '@tanstack/react-query';

type ConfirmOptions = { title: string; onConfirm: () => void };
type MutationOptions = {
  onSuccess?: (result: unknown, input: { provider: string }) => void;
  onError?: (error: Error, input: { provider: string }) => void;
};

const state = vi.hoisted(() => ({
  providers: [] as { provider: string; email: string }[],
  error: false,
  confirm: vi.fn(),
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  openAppShellHandoff: vi.fn(),
  invalidateQueries: vi.fn(),
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
    useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
  };
});
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: state.confirm, dialog: null }),
}));
vi.mock('@/lib/app-shell-handoff', () => ({
  openAppShellHandoff: state.openAppShellHandoff,
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.test' }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getAuthProviders: {
        queryOptions: () => ({}),
        queryKey: () => ['user', 'getAuthProviders'],
      },
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
let queryClient: QueryClient | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(LoginMethodsScreen));
  renderer = view.renderer;
  queryClient = view.queryClient;
  return view.renderer.root;
}

/**
 * Re-render the mounted screen under the providers it was mounted with, so the
 * tree keeps its state. Rendering the screen bare would mount a second tree and
 * drop exactly the state under test.
 */
function rerender() {
  if (!renderer || !queryClient) {
    throw new Error('screen is not mounted');
  }
  const tree = createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(LoginMethodsScreen)
  );
  act(() => {
    renderer?.update(tree);
  });
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
  state.openAppShellHandoff.mockClear();
  state.invalidateQueries.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  queryClient = undefined;
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

  it('refuses to ask when a single linked method is the one being unlinked', async () => {
    state.providers = [{ provider: 'github', email: 'ada@example.test' }];
    const root = await mount();
    const [github] = unlinkButtons(root);
    if (!github) {
      throw new Error('missing GitHub unlink button');
    }

    act(() => {
      (github.props.onPress as () => void)();
    });

    expect(state.confirm).not.toHaveBeenCalled();
    const status = root.findAll(node => Object.is(node.type, 'AccessibleStatus'));
    expect(status.map(node => node.props.message)).toEqual([
      "You can't unlink your only sign-in method. Link another method first.",
    ]);
    expect(state.mutate).not.toHaveBeenCalled();

    // The reader links a second method and the foreground refresh hands this same
    // mounted tree a two-method list.
    state.providers = [
      { provider: 'github', email: 'ada@example.test' },
      { provider: 'google', email: 'ada@example.test' },
    ];
    rerender();

    if (!renderer) {
      throw new Error('missing mounted tree');
    }
    expect(unlinkButtons(renderer.root)).toHaveLength(2);
    const retired = renderer.root.findAll(node => Object.is(node.type, 'AccessibleStatus'));
    expect(retired.map(node => node.props.message)).toEqual([null]);
  });

  it('drops an earlier server answer when a later tap is refused locally', async () => {
    const root = await mount();

    act(() => {
      state.mutations[0]?.onError?.(
        Object.assign(new Error('User does not have a linked github account'), {
          data: { upstreamCode: 'sign_in_method_not_linked' },
        }),
        { provider: 'github' }
      );
    });
    expect(
      root.findAll(node => Object.is(node.type, 'AccessibleStatus')).map(node => node.props.message)
    ).toEqual(['GitHub is no longer linked to your account.']);

    // The reload lands a one-method list, so the tap is refused before the server
    // is asked and that sentence masks the server's earlier answer.
    state.providers = [{ provider: 'github', email: 'ada@example.test' }];
    rerender();
    if (!renderer) {
      throw new Error('missing mounted tree');
    }
    const [github] = unlinkButtons(renderer.root);
    if (!github) {
      throw new Error('missing GitHub unlink button');
    }
    act(() => {
      (github.props.onPress as () => void)();
    });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(
      renderer.root
        .findAll(node => Object.is(node.type, 'AccessibleStatus'))
        .map(node => node.props.message)
    ).toEqual(["You can't unlink your only sign-in method. Link another method first."]);

    // Linking a second method retires the local refusal, and the retired server
    // answer must not come back in its place.
    state.providers = [
      { provider: 'github', email: 'ada@example.test' },
      { provider: 'google', email: 'ada@example.test' },
    ];
    rerender();
    expect(unlinkButtons(renderer.root)).toHaveLength(2);
    expect(
      renderer.root
        .findAll(node => Object.is(node.type, 'AccessibleStatus'))
        .map(node => node.props.message)
    ).toEqual([null]);
  });

  it('reports the last-method rule beside the list in the screen language', async () => {
    state.providers = [{ provider: 'github', email: 'ada@example.test' }];
    const root = await mount();

    act(() => {
      state.mutations[0]?.onError?.(
        Object.assign(new Error('Cannot unlink the last authentication method'), {
          data: { upstreamCode: 'last_sign_in_method' },
        }),
        { provider: 'google' }
      );
    });

    const status = root.findAll(node => Object.is(node.type, 'AccessibleStatus'));
    expect(status.map(node => node.props.message)).toEqual([
      "You can't unlink your only sign-in method. Link another method first.",
    ]);
    expect(state.invalidateQueries).not.toHaveBeenCalled();
  });

  it('names the provider a stale row still shows and reloads the list', async () => {
    const root = await mount();

    act(() => {
      state.mutations[0]?.onError?.(
        Object.assign(new Error('User does not have a linked github account'), {
          data: { upstreamCode: 'sign_in_method_not_linked' },
        }),
        { provider: 'github' }
      );
    });

    const status = root.findAll(node => Object.is(node.type, 'AccessibleStatus'));
    expect(status.map(node => node.props.message)).toEqual([
      'GitHub is no longer linked to your account.',
    ]);
    expect(state.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['user', 'getAuthProviders'],
    });
  });

  it('keeps the server sentence for a failure it does not recognise', async () => {
    const root = await mount();

    act(() => {
      state.mutations[0]?.onError?.(new Error('Something broke on the server'), {
        provider: 'github',
      });
    });

    const status = root.findAll(node => Object.is(node.type, 'AccessibleStatus'));
    expect(status.map(node => node.props.message)).toEqual(['Something broke on the server']);
    expect(state.invalidateQueries).not.toHaveBeenCalled();
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

    expect(state.openAppShellHandoff).toHaveBeenCalledWith(
      { page: 'connected-accounts' },
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
