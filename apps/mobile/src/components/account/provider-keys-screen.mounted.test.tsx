import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ProviderKeysScreen } from './provider-keys-screen';
import type * as ReactQuery from '@tanstack/react-query';

type Key = {
  id: string;
  provider_name: string;
  is_enabled: boolean;
  management_source: string;
};

type MutationOptions = {
  onSuccess?: (result: unknown, input: never) => void;
  onError?: (error: Error) => void;
};

const state = vi.hoisted(() => ({
  keys: [] as Key[],
  error: false,
  confirm: vi.fn(),
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  push: vi.fn(),
  client: {
    invalidateQueries: vi.fn(),
    cancelQueries: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
  },
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.keys,
      isPending: false,
      isError: state.error,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useMutation: (options: MutationOptions) => {
      state.mutations.push(options);
      return { mutate: state.mutate, isPending: false, variables: undefined };
    },
    useQueryClient: () => state.client,
  };
});
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: state.confirm, dialog: null }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    byok: {
      list: { queryOptions: () => ({}), queryKey: () => [] },
      setEnabled: {
        mutationOptions: (options: MutationOptions) => ({ kind: 'setEnabled', ...options }),
      },
      testApiKey: { mutationOptions: (options: MutationOptions) => ({ kind: 'test', ...options }) },
      delete: { mutationOptions: (options: MutationOptions) => ({ kind: 'delete', ...options }) },
    },
  }),
}));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound', Plus: 'Plus' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));

const SWITCH = 'Switch' as ElementType;
const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ProviderKeysScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function switchFor(root: ReactTestRenderer['root'], provider: string) {
  const found = root.findAll(
    node => Object.is(node.type, SWITCH) && String(node.props.accessibilityLabel).includes(provider)
  );
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one switch for ${provider}, found ${found.length}`);
  }
  return only;
}

function button(root: ReactTestRenderer['root'], label: string) {
  const found = root.findAll(
    node =>
      Object.is(node.type, BUTTON) &&
      node.findAll(child => child.props.children === label).length > 0
  );
  const [first] = found;
  if (!first) {
    throw new Error(`missing ${label} button`);
  }
  return first;
}

function lastConfirm() {
  const call = state.confirm.mock.calls.at(-1)?.[0] as
    | { title: string; onConfirm: () => void }
    | undefined;
  if (!call) {
    throw new Error('confirm was never asked');
  }
  return call;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.keys = [
    {
      id: 'key-1',
      provider_name: 'Anthropic',
      is_enabled: true,
      management_source: 'user',
    },
  ];
  state.error = false;
  state.mutations = [];
  state.mutate.mockClear();
  state.confirm.mockClear();
  state.push.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProviderKeysScreen', () => {
  it('shows each key with its provider name and whether it is in use', async () => {
    const root = await mount();

    const texts = root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => node.props.children);
    expect(texts).toEqual(expect.arrayContaining(['Anthropic', 'In use']));
  });

  it('sends the new value when a key is switched off', async () => {
    const root = await mount();

    act(() => {
      (switchFor(root, 'Anthropic').props.onValueChange as (value: boolean) => void)(false);
    });

    expect(state.mutate).toHaveBeenCalledWith({ id: 'key-1', is_enabled: false });
  });

  it('tests a key through the server', async () => {
    const root = await mount();

    act(() => {
      (button(root, 'Test key').props.onPress as () => void)();
    });

    expect(state.mutate).toHaveBeenCalledWith({ id: 'key-1' });
  });

  it('asks before removing a key and then deletes it', async () => {
    const root = await mount();

    act(() => {
      (button(root, 'Remove').props.onPress as () => void)();
    });

    expect(lastConfirm().title).toBe('Remove the Anthropic key?');
    expect(state.mutate).not.toHaveBeenCalled();

    act(() => {
      lastConfirm().onConfirm();
    });
    expect(state.mutate).toHaveBeenCalledWith({ id: 'key-1' });
  });

  it('closes every control on a key the coding plan manages', async () => {
    state.keys = [
      { id: 'key-2', provider_name: 'OpenAI', is_enabled: true, management_source: 'coding_plan' },
    ];
    const root = await mount();

    expect(switchFor(root, 'OpenAI').props.disabled).toBe(true);
    expect(button(root, 'Test key').props.disabled).toBe(true);
    const texts = root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => node.props.children);
    expect(texts).toContain('Managed by your coding plan');
  });

  it('points an empty account at the add form', async () => {
    state.keys = [];
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual(['No provider keys']);

    act(() => {
      (button(root, 'Add key').props.onPress as () => void)();
    });
    expect(state.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/provider-key-add');
  });
});
