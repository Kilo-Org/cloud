import { createElement, type ReactNode, type Ref, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { type RepositoryRow, RepositoryRowsList } from './repository-rows-list';

const ROWS: RepositoryRow[] = [
  { id: 1, fullName: 'kilo-org/cloud' },
  { id: 2, fullName: 'kilo-org/cloud-tools' },
  { id: 3, fullName: 'acme/widgets' },
];

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
}));
vi.mock('@/components/ui/input', () => ({ Input: 'TextInput' }));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', SearchX: 'SearchX', X: 'X' }));
vi.mock('@/components/repo-toggle-row', () => ({ RepoToggleRow: 'RepoToggleRow' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@shopify/flash-list', async () => {
  // `vi.mock` factories run before the file's imports bind.
  const { createElement: create, forwardRef, useImperativeHandle } = await import('react');
  return {
    FlashList: forwardRef(function FlashListStub(
      props: {
        data?: RepositoryRow[];
        renderItem: (info: { item: RepositoryRow; index: number }) => ReactNode;
        ListHeaderComponent?: ReactNode;
      },
      ref: Ref<unknown>
    ) {
      // The list resets its offset when the query changes.
      useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }), []);
      return create(
        'FlashList',
        props,
        props.ListHeaderComponent,
        (props.data ?? []).map((item, index) =>
          create('ReviewRow', { key: index }, props.renderItem({ item, index }))
        )
      );
    }),
  };
});

/** Lets a test flip the prop the screen derives, without remounting the list. */
const controls: { setSearchable: (next: boolean) => void } = {
  setSearchable: () => undefined,
};

function Harness({ initialSearchable = true }: Readonly<{ initialSearchable?: boolean }>) {
  const [searchable, setSearchable] = useState(initialSearchable);
  controls.setSearchable = setSearchable;
  return (
    <RepositoryRowsList
      repositories={ROWS}
      selectedIds={[]}
      disabled={false}
      onToggle={() => undefined}
      searchable={searchable}
      header={null}
      headerGapClass="pb-2"
      style={{}}
      onLayout={() => undefined}
    />
  );
}

function rowNames(renderer: RenderWithProvidersResult['renderer']): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'RepoToggleRow')
    .map(node => {
      // The row stub is a host node, so the test renderer exposes its props
      // untyped; this suite renders the real row component's props.
      const { repo } = node.props as { repo: { fullName: string } };
      return repo.fullName;
    });
}

function typeQuery(renderer: RenderWithProvidersResult['renderer'], query: string): void {
  const input = renderer.root.findByType('TextInput');
  act(() => {
    (input.props.onChangeText as (text: string) => void)(query);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RepositoryRowsList search', () => {
  it('narrows the rows to the query and restores them on clear', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(Harness));
    expect(rowNames(renderer)).toEqual(['kilo-org/cloud', 'kilo-org/cloud-tools', 'acme/widgets']);

    typeQuery(renderer, 'CLOUD');
    expect(rowNames(renderer)).toEqual(['kilo-org/cloud', 'kilo-org/cloud-tools']);

    typeQuery(renderer, '');
    expect(rowNames(renderer)).toEqual(['kilo-org/cloud', 'kilo-org/cloud-tools', 'acme/widgets']);
    unmount();
  });

  it('drops the query when the field is not shown, so the list cannot come back filtered', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(Harness));
    typeQuery(renderer, 'widgets');
    expect(rowNames(renderer)).toEqual(['acme/widgets']);

    act(() => {
      controls.setSearchable(false);
    });
    expect(renderer.root.findAll(node => String(node.type) === 'TextInput')).toHaveLength(0);

    act(() => {
      controls.setSearchable(true);
    });
    expect(rowNames(renderer)).toEqual(['kilo-org/cloud', 'kilo-org/cloud-tools', 'acme/widgets']);
    unmount();
  });
});
