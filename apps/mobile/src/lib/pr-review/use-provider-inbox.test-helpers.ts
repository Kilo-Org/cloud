import { createElement, type ReactNode } from 'react';
import { vi } from 'vitest';

// Native hosts only: the inbox, authorization queries, and reconnect mutation
// remain real in the mounted recovery tests.
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  Clock: 'Clock',
  GitPullRequest: 'GitPullRequest',
  Inbox: 'Inbox',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data: readonly { key: string }[];
    renderItem: (args: { item: { key: string } }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
    ListFooterComponent: ReactNode;
  }) =>
    createElement(
      'FlashList',
      null,
      props.ListHeaderComponent,
      props.data.length > 0
        ? props.data.map(item =>
            createElement('Row', { key: item.key }, props.renderItem({ item }))
          )
        : props.ListEmptyComponent,
      props.ListFooterComponent
    ),
}));
