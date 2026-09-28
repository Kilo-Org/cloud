import { createElement, type ReactNode } from 'react';
import { vi } from 'vitest';

import type * as UtilsModule from '@/lib/utils';

/**
 * `parseTimestamp` spy for tests that count parses. This helper registers the
 * partial `@/lib/utils` mock (`utilsMockFactory`) for every file that imports
 * it, so a test asserts on `parseTimestampSpy`; the factory delegates each call
 * to the real export and leaves every other `@/lib/utils` export untouched.
 */
export const parseTimestampSpy = vi.fn();

async function utilsMockFactory(
  importOriginal: <T = unknown>() => Promise<T>
): Promise<Record<string, unknown>> {
  const actual = await importOriginal<typeof UtilsModule>();
  parseTimestampSpy.mockImplementation(actual.parseTimestamp);
  return { ...actual, parseTimestamp: parseTimestampSpy };
}
vi.mock('@/lib/utils', utilsMockFactory);

// Native hosts only: the inbox, authorization queries, and reconnect mutation
// remain real in the mounted recovery tests.
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
// The mounted tree reads landscape insets from the inbox list; the real
// package pulls Flow-typed react-native, which this DOM-free transform
// cannot parse.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
