/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); same pattern as src/test/render-with-providers.tsx. */

// Inbox row accessibility regression: the row must announce its children as
// ONE button — title first — the way ConfigureRow rows do on Home and
// Profile. An explicit accessibilityLabel on the row replaces the children,
// which drops the merge-request title (the row's primary content) from what
// a screen reader says, and from anything that reads the accessibility tree.

import { createElement, type ReactElement, type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { PrReviewInboxList } from './pr-review-inbox-list';

type Row = {
  ref: { platform: 'gitlab'; projectPath: string; mrIid: number };
  key: string;
  title: string;
  isDraft: boolean;
  updatedAt: string;
};

const inbox = vi.hoisted(() => ({
  items: [
    {
      ref: { platform: 'gitlab' as const, projectPath: 'igor352/kilo-e2e-personal', mrIid: 1 },
      key: 'gitlab|gitlab.com|igor352/kilo-e2e-personal|1',
      title: 'E2E review fixture',
      isDraft: false,
      updatedAt: '2026-01-03T00:00:00Z',
    },
  ],
  isPending: false,
  firstPageErrorState: null,
  laterPageError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetching: false,
  refetch: vi.fn(),
  retryFailedPages: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@/lib/pr-review/use-provider-inbox', () => ({
  useProviderInbox: () => inbox,
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: Row[];
    renderItem?: (info: { item: Row; index: number }) => ReactElement | null;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ListEmptyComponent?: ReactElement;
  }) =>
    createElement(
      'FlashList',
      null,
      props.ListHeaderComponent,
      // Real FlashList renders the empty component only when there are no
      // rows; the happy-path list must not also mount the error branch.
      ...(props.data && props.data.length > 0
        ? props.data.map((item, index) => props.renderItem?.({ item, index }))
        : [props.ListEmptyComponent]),
      props.ListFooterComponent
    ),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/ui/icons', () => ({
  Clock: 'Clock',
  GitPullRequest: 'GitPullRequest',
  Inbox: 'Inbox',
}));

vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: 'Skeleton',
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));

vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
}));

vi.mock('@/components/query-error', () => ({
  QueryError: 'QueryError',
}));

vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#8a8a8a' }),
}));

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
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

describe('pr-review inbox row', () => {
  it('is one button that announces its children, title included', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(PrReviewInboxList, {
        header: createElement('Header'),
        recents: createElement('Recents'),
      })
    );

    const rows = renderer.root.findAll(node => node.type === Pressable);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) {
      throw new Error(`expected exactly one inbox row, got ${rows.length}`);
    }
    expect(row.props.accessibilityRole).toBe('button');
    // The defect: an explicit label replaces the children, hiding the title.
    expect(row.props.accessibilityLabel).toBeUndefined();

    const rendered = collectText(row.children).join('\n');
    expect(rendered).toContain('E2E review fixture');
    expect(rendered).toContain('igor352/kilo-e2e-personal!1');
    expect(rendered).toContain('Merge request');

    unmount();
  });
});
