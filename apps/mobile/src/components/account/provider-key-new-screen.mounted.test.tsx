import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ProviderKeyNewScreen } from './provider-key-new-screen';
import type * as ReactQuery from '@tanstack/react-query';

type MutationOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

type ScreenState = {
  params: Record<string, string>;
  providers: { id: string; name: string }[];
  error: boolean;
  mutations: MutationOptions[];
  mutate: Mock;
  dismissTo: Mock;
  toastError: Mock;
};

const state = vi.hoisted((): ScreenState => ({
  params: { provider: 'anthropic' },
  providers: [{ id: 'anthropic', name: 'Anthropic' }],
  error: false,
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  dismissTo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => state.params,
  useRouter: () => ({ dismissTo: state.dismissTo }),
}));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.providers,
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
vi.mock('sonner-native', () => ({
  toast: { error: state.toastError, success: vi.fn() },
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    byok: {
      listProviders: { queryOptions: () => ({}), queryKey: () => [] },
      list: { queryKey: () => [] },
      create: { mutationOptions: (options: MutationOptions) => options },
    },
  }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));

const FIELD = 'FormField' as ElementType;
const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ProviderKeyNewScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function apiKeyField(root: ReactTestRenderer['root']) {
  const [field] = root.findAll(node => Object.is(node.type, FIELD));
  if (!field) {
    throw new Error('missing API key field');
  }
  return field;
}

function addButton(root: ReactTestRenderer['root']) {
  const found = root.findAll(node => Object.is(node.type, BUTTON));
  const last = found.at(-1);
  if (!last) {
    throw new Error('missing Add key button');
  }
  return last;
}

function submit(root: ReactTestRenderer['root'], key: string): void {
  act(() => {
    (apiKeyField(root).props.onChangeText as (value: string) => void)(key);
  });
  act(() => {
    (addButton(root).props.onPress as () => void)();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.params = { provider: 'anthropic' };
  state.providers = [{ id: 'anthropic', name: 'Anthropic' }];
  state.error = false;
  state.mutations = [];
  state.mutate.mockClear();
  state.dismissTo.mockClear();
  state.toastError.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProviderKeyNewScreen', () => {
  it('names the chosen provider and masks the key field', async () => {
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children)
    ).toContain('Anthropic');
    expect(apiKeyField(root).props.secureTextEntry).toBe(true);
  });

  it('sends the provider and the trimmed key once', async () => {
    const root = await mount();

    submit(root, '  sk-test-123  ');

    expect(state.mutate).toHaveBeenCalledWith({
      provider_id: 'anthropic',
      api_key: 'sk-test-123',
    });
  });

  it('refuses to submit an empty key', async () => {
    const root = await mount();

    submit(root, '   ');

    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledWith('Enter the key.');
  });

  it('reports a refused key in place and stays on the form', async () => {
    const root = await mount();
    submit(root, 'sk-test-123');

    act(() => {
      state.mutations[0]?.onError?.(new Error('That key was rejected by the provider'));
    });

    expect(
      root.findAll(node => Object.is(node.type, 'AccessibleStatus')).map(node => node.props.message)
    ).toEqual(['That key was rejected by the provider']);
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('drops the saved key so it cannot be sent twice', async () => {
    const root = await mount();
    submit(root, 'sk-test-123');

    act(() => {
      state.mutations[0]?.onSuccess?.();
    });
    act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.toastError).toHaveBeenCalledWith('Enter the key.');
  });

  it('returns to the list after the key is added', async () => {
    const root = await mount();
    submit(root, 'sk-test-123');

    act(() => {
      state.mutations[0]?.onSuccess?.();
    });

    expect(state.dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/provider-keys');
  });

  it('treats a provider the server does not offer as an invalid link', async () => {
    state.params = { provider: 'not-a-provider' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'InvalidRouteState'))).toHaveLength(1);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });
});
