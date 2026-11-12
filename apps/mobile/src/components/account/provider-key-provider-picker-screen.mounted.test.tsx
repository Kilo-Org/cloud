import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ProviderKeyProviderPickerScreen } from './provider-key-provider-picker-screen';
import type * as ReactQuery from '@tanstack/react-query';

type Provider = { id: string; name: string };

const state = vi.hoisted(() => ({
  providers: [] as Provider[],
  error: false,
  push: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', TextInput: 'TextInput' }));
vi.mock('@shopify/flash-list', async () => {
  // `vi.mock` factories are hoisted above this file's imports, so `react` has to
  // be loaded from inside the factory rather than at the top of the module.
  const React = await import('react');
  return {
    FlashList: (props: {
      data: unknown[];
      renderItem: (info: { item: unknown }) => React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) =>
      React.createElement(
        'FlashList',
        { itemCount: props.data.length },
        props.data.length === 0
          ? props.ListEmptyComponent
          : props.data.map((item, index) =>
              React.createElement(React.Fragment, { key: index }, props.renderItem({ item }))
            )
      ),
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
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
  };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ byok: { listProviders: { queryOptions: () => ({}), queryKey: () => [] } } }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));
vi.mock('@/lib/a11y/tap-target', () => ({
  COMPACT_CONTROL_HIT_SLOP_DP: 8,
  ROW_TARGET_CLASS: 'min-h-11',
  STATE_ACTION_CLASS: '',
}));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', X: 'X' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'Chevron',
}));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ProviderKeyProviderPickerScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function rowLabels(root: ReactTestRenderer['root']) {
  return root.findAll(
    node => Object.is(node.type, 'Pressable') && typeof node.props.accessibilityLabel === 'string'
  );
}

function row(root: ReactTestRenderer['root'], index: number) {
  const found = rowLabels(root)[index];
  if (!found) {
    throw new Error(`missing provider row ${index}`);
  }
  return found;
}

function searchInput(root: ReactTestRenderer['root']) {
  const [input] = root.findAll(node => Object.is(node.type, 'Input'));
  if (!input) {
    throw new Error('missing provider search input');
  }
  return input;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.providers = [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'openai', name: 'OpenAI' },
  ];
  state.error = false;
  state.push.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProviderKeyProviderPickerScreen', () => {
  it('lists every provider the server offers', async () => {
    const root = await mount();

    const labels = rowLabels(root).map(node => node.props.accessibilityLabel);
    expect(labels).toEqual(['Anthropic', 'OpenAI']);
  });

  it('opens the key form with the chosen provider', async () => {
    const root = await mount();

    act(() => {
      (row(root, 1).props.onPress as () => void)();
    });

    expect(state.push).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(3_profile)/provider-key-new',
      params: { provider: 'openai' },
    });
  });

  it('filters by name and explains when nothing matches', async () => {
    const root = await mount();

    act(() => {
      (searchInput(root).props.onChangeText as (value: string) => void)('gpt');
    });

    expect(rowLabels(root)).toHaveLength(0);
    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual(['No matching providers']);
  });

  it('matches a provider by its id', async () => {
    const root = await mount();

    act(() => {
      (searchInput(root).props.onChangeText as (value: string) => void)('openai');
    });

    expect(rowLabels(root).map(node => node.props.accessibilityLabel)).toEqual(['OpenAI']);
  });

  it('matches an id whose capital I was typed in a Turkish locale', async () => {
    state.providers = [{ id: 'vercel-ai-gateway', name: 'Vercel AI Gateway' }];
    await i18n.changeLanguage('tr');
    try {
      const root = await mount();

      act(() => {
        (searchInput(root).props.onChangeText as (value: string) => void)('Vercel-AI-Gateway');
      });

      expect(rowLabels(root).map(node => node.props.accessibilityLabel)).toEqual([
        'Vercel AI Gateway',
      ]);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('keeps a retry when the provider list cannot be read', async () => {
    state.error = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });
});
