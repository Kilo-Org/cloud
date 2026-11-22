import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type RepoOption } from './repo-bindings-model';
import { RepoPickerSheet } from './repo-picker-sheet';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/search-field', () => ({ SearchField: 'SearchField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  GitBranch: 'GitBranch',
  Lock: 'Lock',
  SearchX: 'SearchX',
  Unlock: 'Unlock',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/lib/picker-list', () => ({
  SEARCHABLE_PICKER_LIST_PROPS: {},
  dismissSearchPickerKeyboard: vi.fn(),
}));

const githubRepo: RepoOption = { platform: 'github', fullName: 'acme/widgets', private: false };

/** The first host node of a mocked component type (host node types are not in the intrinsic map). */
function nodeOfType(root: ReactTestInstance, type: string): ReactTestInstance | undefined {
  return root.findAll(node => node.type === type)[0];
}

/** How many host nodes of a mocked component type the tree holds. */
function countOfType(root: ReactTestInstance, type: string): number {
  return root.findAll(node => node.type === type).length;
}

type QueryErrorNode = { props: { title?: string; onRetry?: () => void } };

function queryErrorOf(root: ReactTestInstance): QueryErrorNode {
  const node = nodeOfType(root, 'QueryError');
  if (!node) {
    throw new Error('the query error did not render');
  }
  // The mocked surface is a host node, so its props are untyped at the boundary.
  return { props: node.props as QueryErrorNode['props'] };
}

describe('repo picker sheet', () => {
  it('error: names the repository list, not the profiles it does not show', async () => {
    const onRetry = vi.fn<() => void>();
    const { renderer, unmount } = await renderWithProviders(
      createElement(RepoPickerSheet, {
        repositories: [],
        isLoading: false,
        isError: true,
        onRetry,
        selectedKey: null,
        onSelect: vi.fn<(repo: RepoOption) => void>(),
        onClose: vi.fn<() => void>(),
      })
    );

    expect(countOfType(renderer.root, 'QueryError')).toBe(1);
    expect(queryErrorOf(renderer.root).props.title).toBe(i18n.t('common.couldNotLoadRepositories'));
    expect(queryErrorOf(renderer.root).props.title).toBe('Could not load repositories');
    expect(queryErrorOf(renderer.root).props.title).not.toBe(i18n.t('profiles.loadFailed'));

    act(() => {
      (queryErrorOf(renderer.root).props.onRetry as () => void)();
    });
    expect(onRetry).toHaveBeenCalledOnce();

    unmount();
  });

  it('loading: content-shaped rows and no query error', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(RepoPickerSheet, {
        repositories: [],
        isLoading: true,
        isError: false,
        onRetry: vi.fn<() => void>(),
        selectedKey: null,
        onSelect: vi.fn<(repo: RepoOption) => void>(),
        onClose: vi.fn<() => void>(),
      })
    );

    expect(countOfType(renderer.root, 'RowSkeleton')).toBeGreaterThan(0);
    expect(countOfType(renderer.root, 'QueryError')).toBe(0);

    unmount();
  });

  it('happy: one row per repository option, and a tap selects it', async () => {
    const onSelect = vi.fn<(repo: RepoOption) => void>();
    const { renderer, unmount } = await renderWithProviders(
      createElement(RepoPickerSheet, {
        repositories: [githubRepo],
        isLoading: false,
        isError: false,
        onRetry: vi.fn<() => void>(),
        selectedKey: null,
        onSelect,
        onClose: vi.fn<() => void>(),
      })
    );

    expect(countOfType(renderer.root, 'ChoiceRow')).toBe(1);

    const row = nodeOfType(renderer.root, 'ChoiceRow');
    if (!row) {
      throw new Error('the repository row did not render');
    }
    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(onSelect).toHaveBeenCalledWith(githubRepo);

    unmount();
  });
});
