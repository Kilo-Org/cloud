import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ProviderKeyProviderPickerScreen } from './provider-key-provider-picker-screen';
import type * as ReactQuery from '@tanstack/react-query';

/**
 * The provider picker shows the app's own name for a descriptive provider, so
 * the search has to match that name and not only the English one the server
 * sent. Kept in its own file because the shared picker test is at its lint
 * length limit.
 */
const state = vi.hoisted(() => ({
  providers: [] as { id: string; name: string }[],
}));

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', TextInput: 'TextInput' }));
vi.mock('@shopify/flash-list', async () => {
  const React = await import('react');
  return {
    FlashList: React.forwardRef(
      (
        props: { data: unknown[]; renderItem: (info: { item: unknown }) => React.ReactNode },
        ref
      ) => {
        React.useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined, props: {} }));
        return React.createElement(
          'FlashList',
          { itemCount: props.data.length },
          props.data.map((item, index) =>
            React.createElement(React.Fragment, { key: index }, props.renderItem({ item }))
          )
        );
      }
    ),
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.providers,
      isPending: false,
      isError: false,
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
  FIELD_CLEAR_BOX_CLASS: 'h-[48px] w-[48px] -my-[7px] items-center justify-center',
  ROW_TARGET_CLASS: 'min-h-11',
  STATE_ACTION_CLASS: '',
  TOUCH_TARGET_OVERHANG_DP: 8,
}));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', X: 'X' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'Chevron',
}));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));

let renderer: ReactTestRenderer | undefined = undefined;

afterEach(async () => {
  act(() => renderer?.unmount());
  renderer = undefined;
  await i18n.changeLanguage('en');
});

function rowLabels(root: ReactTestRenderer['root']) {
  return root
    .findAll(node => Object.is(node.type, 'FlashList'))
    .flatMap(list =>
      list.findAll(
        node =>
          Object.is(node.type, 'Pressable') && typeof node.props.accessibilityLabel === 'string'
      )
    );
}

function searchInput(root: ReactTestRenderer['root']) {
  const [input] = root.findAll(node => Object.is(node.type, 'Input'));
  if (!input) {
    throw new Error('missing provider search input');
  }
  return input;
}

describe('ProviderKeyProviderPickerScreen translated names', () => {
  it('shows a descriptive name in the app language and finds it by that name', async () => {
    state.providers = [{ id: 'codestral', name: 'Legacy Codestral-only key' }];
    await i18n.changeLanguage('pt-BR');
    const view = await renderWithProviders(createElement(ProviderKeyProviderPickerScreen, {}));
    renderer = view.renderer;
    const root = view.renderer.root;

    const shown = rowLabels(root).map(node => node.props.accessibilityLabel);
    expect(shown).toEqual([i18n.t('profile.providerKeys.names.codestral')]);

    act(() => {
      (searchInput(root).props.onChangeText as (value: string) => void)('Somente');
    });

    expect(rowLabels(root).map(node => node.props.accessibilityLabel)).toEqual(shown);
  });
});
