/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); same pattern as src/test/render-with-providers.tsx. */

// Screen-level empty-state precedence regression: when the member query errors
// with no data, both member arrays are empty, so the list's empty component
// must render the QueryError — not "No members yet". The item builder and the
// error selector are unit-tested separately; this proves the loading → error →
// empty precedence in the screen JSX itself.

import { type ComponentType, createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { OrganizationMembersScreen } from './members-screen';

const withMembersQuery = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => true,
  useOrgBoundary: () => ({
    organizationId: 'org-1',
    role: 'owner',
    org: { organizationId: 'org-1', role: 'owner' },
    isResolving: false,
  }),
  useOrgWithMembers: () => withMembersQuery,
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: unknown[];
    ListEmptyComponent?: ComponentType | ReactElement | null;
  }) => {
    const data = props.data ?? [];
    if (data.length === 0) {
      const Empty = props.ListEmptyComponent;
      if (typeof Empty === 'function') {
        return createElement(Empty);
      }
      return Empty ?? null;
    }
    return null;
  },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/ui/icons', () => ({
  UserPlus: 'UserPlus',
  Users: 'Users',
}));

vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => `EMPTY_STATE:${title}`,
}));

vi.mock('@/components/organization/invited-member-row', () => ({
  InvitedMemberRow: () => null,
}));

vi.mock('@/components/organization/member-row', () => ({
  MemberRow: () => null,
}));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: () => null,
}));

vi.mock('@/components/query-error', () => ({
  QueryError: () => 'QUERY_ERROR',
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: 'Skeleton',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/tab-screen', () => ({
  useTabBarBottomPadding: () => 0,
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000' }),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  firstNonEmpty: (...args: (string | null | undefined)[]) =>
    args.find(value => value != null && value !== '') ?? '',
  parseTimestamp: (value: string) => new Date(value),
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
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

async function renderScreen(): Promise<string[]> {
  const { renderer } = await renderWithProviders(createElement(OrganizationMembersScreen));
  return collectText(renderer.toJSON());
}

beforeEach(() => {
  withMembersQuery.data = undefined;
  withMembersQuery.isLoading = false;
  withMembersQuery.isFetching = false;
  withMembersQuery.isError = false;
  withMembersQuery.error = null;
  withMembersQuery.refetch.mockClear();
});

describe('OrganizationMembersScreen empty-state precedence', () => {
  it('renders QueryError, not "No members yet", when an error leaves both member arrays empty', async () => {
    withMembersQuery.isError = true;
    withMembersQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };

    const texts = await renderScreen();

    expect(texts).toContain('QUERY_ERROR');
    expect(texts).not.toContain('No members yet');
  });

  it('renders "No members yet" when there is no error and both member arrays are empty', async () => {
    const texts = await renderScreen();

    expect(texts).not.toContain('QUERY_ERROR');
    expect(texts).toContain('EMPTY_STATE:No members yet');
  });
});
