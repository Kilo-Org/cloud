// The provider allow list's empty copy. An organization whose catalog resolves
// no provider has a list that simply has nothing to switch, so the empty state
// must say that, not report a search that matched nothing. A typed query keeps
// the search copy, and whitespace alone is not a search. These tests read the
// app's real English catalog instead of mocking `react-i18next`, so they assert
// the copy a person actually sees.

import { createElement, Fragment, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { type ModelAccessDraft } from '@/lib/organization/model-access';
import { ProviderAllowList } from './model-access-lists';

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: readonly string[];
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    renderItem?: (info: { item: string; index: number }) => ReactNode;
  }) => {
    const data = props.data ?? [];
    return createElement(
      'FlashList',
      null,
      props.ListHeaderComponent,
      ...data.map((item, index) =>
        createElement(Fragment, { key: item }, props.renderItem?.({ item, index }) ?? null)
      ),
      data.length === 0 ? props.ListEmptyComponent : null
    );
  },
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string }) => createElement('EmptyState', props, props.title),
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: ReactNode }) => createElement('Button', null, props.children),
}));
vi.mock('@/components/ui/filter-chip', () => ({ FilterChip: 'FilterChip' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/row-group', () => ({
  RowGroupItem: 'RowGroupItem',
  rowGroupPosition: () => 'only',
}));
vi.mock('@/components/ui/search-field', () => ({
  SearchField: (props: { onChangeText: (text: string) => void }) =>
    createElement('SearchField', props),
}));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('Text', null, props.children),
}));

function draft(): ModelAccessDraft {
  return { modelDenyList: [], providerAllowList: [] };
}

async function mount(providers: readonly string[]): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(ProviderAllowList, {
        disabled: false,
        draft: draft(),
        onChange: () => undefined,
        providers,
      })
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('the provider allow list did not render');
  }
  return ref.current;
}

/** Type into the list's search field; the field is uncontrolled, so the list's
 * own state change is what re-renders it. */
function typeIntoSearch(renderer: TestRenderer.ReactTestRenderer, text: string): void {
  const field = renderer.root.find(node => String(node.type) === 'SearchField');
  // The test tree carries host props untyped, and this field receives exactly
  // one handler under that name: the list's own `onChangeText`.
  const onChangeText = field.props.onChangeText as ((value: string) => void) | undefined;
  if (!onChangeText) {
    throw new TypeError('the search field has no change handler');
  }
  act(() => {
    onChangeText(text);
  });
}

/** Every string the mounted tree prints, in render order. */
function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText(node.children);
  }
  return [];
}

const NO_PROVIDERS = i18n.t('organizationModelAccess.providersNone');
const NO_MATCH = i18n.t('organizationModelAccess.providersEmpty');

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

async function renderList(providers: readonly string[]): Promise<string[]> {
  renderer = await mount(providers);
  return collectText(renderer.toJSON());
}

afterEach(() => {
  if (renderer) {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  }
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

describe('ProviderAllowList empty copy', () => {
  it('names the missing list when the catalog resolves no provider and nothing is typed', async () => {
    // The two copies differ, so a branch mix-up cannot pass as the other one.
    expect(NO_PROVIDERS).not.toBe(NO_MATCH);

    const texts = await renderList([]);

    expect(texts).toContain(NO_PROVIDERS);
    expect(texts).not.toContain(NO_MATCH);
  });

  it('reports a failed search when a query is typed into a list with no providers', async () => {
    const texts = await renderList([]);
    if (!renderer) {
      throw new Error('the provider allow list did not render');
    }

    typeIntoSearch(renderer, 'openai');

    const after = collectText(renderer.toJSON());
    expect(after).toContain(NO_MATCH);
    expect(after).not.toContain(NO_PROVIDERS);
    expect(texts).toContain(NO_PROVIDERS);
  });

  it('reports a failed search when the query matches no provider in a loaded catalog', async () => {
    await renderList(['anthropic', 'openai']);
    if (!renderer) {
      throw new Error('the provider allow list did not render');
    }

    typeIntoSearch(renderer, 'gemini');

    const after = collectText(renderer.toJSON());
    expect(after).toContain(NO_MATCH);
    expect(after).not.toContain(NO_PROVIDERS);
  });

  it('treats a whitespace-only query as no search at all', async () => {
    await renderList([]);
    if (!renderer) {
      throw new Error('the provider allow list did not render');
    }

    typeIntoSearch(renderer, '   ');

    const after = collectText(renderer.toJSON());
    expect(after).toContain(NO_PROVIDERS);
    expect(after).not.toContain(NO_MATCH);
  });
});
