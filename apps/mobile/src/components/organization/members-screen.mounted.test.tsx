// Screen-level empty-state precedence regression: when the member query errors
// with no data, both member arrays are empty, so the list's empty component
// must render the QueryError — not "No members yet". The item builder and the
// error selector are unit-tested separately; this proves the loading → error →
// empty precedence in the screen JSX itself.

import {
  type ComponentType,
  createElement,
  Fragment,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type TestRenderer } from '@/test/renderer';
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

const routerPush = vi.hoisted(() => vi.fn());

/** The smallest box the control-size audit accepts on a control's own node. */
const MIN_BOX_DP = 28;
/** DESIGN.md: the target every control must reach, in points. */
const MIN_REACH_DP = 44;
/** One Tailwind spacing unit, in dp. */
const SPACING_UNIT_DP = 4;

/** Read a Tailwind `h-*`/`w-*` class as dp (`h-[32px]` or `h-8`). */
function sideFromClass(className: unknown, axis: 'h' | 'w'): number {
  const source = typeof className === 'string' ? className : '';
  const arbitrary = new RegExp(String.raw`(?:^|\s)${axis}-\[(\d+(?:\.\d+)?)px\]`).exec(source);
  if (arbitrary?.[1]) {
    return Number(arbitrary[1]);
  }
  const scaled = new RegExp(String.raw`(?:^|\s)${axis}-(\d+(?:\.\d+)?)(?!\S)`).exec(source);
  if (scaled?.[1]) {
    return Number(scaled[1]) * SPACING_UNIT_DP;
  }
  throw new Error(`no ${axis} size in class: ${source}`);
}

/** The reach added per side by `hitSlop`, whatever shape it takes. */
function hitSlopPerSide(hitSlop: unknown): number {
  if (typeof hitSlop === 'number') {
    return hitSlop;
  }
  if (hitSlop != null && typeof hitSlop === 'object') {
    const sides = hitSlop as Record<string, number | undefined>;
    return Math.min(sides.top ?? 0, sides.bottom ?? 0, sides.left ?? 0, sides.right ?? 0);
  }
  return 0;
}

function findInviteControl(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Invite member'
  );
}

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => true,
  isActiveOrgMember: (member: { status: string }) => member.status === 'active',
  isInvitedOrgMember: (member: { status: string }) => member.status === 'invited',
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
    renderItem?: (info: { item: unknown; index: number }) => ReactElement;
  }) => {
    const data = props.data ?? [];
    const Empty = props.ListEmptyComponent;
    if (data.length > 0) {
      return createElement(
        'FlashList',
        null,
        data.map((item, index) =>
          createElement(Fragment, { key: index }, props.renderItem?.({ item, index }))
        )
      );
    }
    return createElement(
      'FlashList',
      null,
      typeof Empty === 'function' ? createElement(Empty) : Empty
    );
  },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/components/ui/icons', () => ({
  UserPlus: 'UserPlus',
  Users: 'Users',
}));

vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string; placement?: string; action?: ReactNode }) =>
    createElement('EmptyState', props, `EMPTY_STATE:${props.title}`, props.action),
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
  ScreenHeader: (props: { headerRight?: ReactNode }) =>
    createElement('ScreenHeader', null, props.headerRight),
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
  routerPush.mockClear();
});

describe('OrganizationMembersScreen empty-state precedence', () => {
  it('renders QueryError, not "No members yet", when an error leaves both member arrays empty', async () => {
    withMembersQuery.isError = true;
    withMembersQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };

    const texts = await renderScreen();

    expect(texts).toContain('QUERY_ERROR');
    expect(texts).not.toContain('No members yet');
  });

  it('renders "No members yet" outside the list when both member arrays are empty', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrganizationMembersScreen)
    );
    const texts = collectText(renderer.toJSON());

    expect(texts).not.toContain('QUERY_ERROR');
    expect(texts).toContain('EMPTY_STATE:No members yet');
    expect(renderer.root.findAll(node => String(node.type) === 'FlashList')).toHaveLength(0);
    unmount();
  });

  it('keeps the empty member notice inline above cached invitations after a refetch failure', async () => {
    withMembersQuery.isError = true;
    withMembersQuery.data = {
      settings: {},
      members: [{ status: 'invited', inviteId: 'invite-1', inviteDate: null }],
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrganizationMembersScreen)
    );
    const list = renderer.root.find(node => String(node.type) === 'FlashList');
    expect(list.find(node => String(node.type) === 'EmptyState').props).toMatchObject({
      placement: 'top',
    });
    expect(collectText(renderer.toJSON())).not.toContain('QUERY_ERROR');
    unmount();
  });

  it('keeps the loading skeleton ahead of error and empty states', async () => {
    withMembersQuery.isLoading = true;
    withMembersQuery.isError = true;
    const texts = await renderScreen();
    expect(texts).not.toContain('QUERY_ERROR');
    expect(texts).not.toContain('EMPTY_STATE:No members yet');
  });
});

describe('OrganizationMembersScreen invite header control', () => {
  it('renders the invite control with at least a 28dp box and a 44pt reach', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrganizationMembersScreen)
    );

    const controls = findInviteControl(renderer.root);
    expect(controls).toHaveLength(1);
    const control = controls[0];
    if (!control) {
      throw new Error('invite control not found');
    }

    const height = sideFromClass(control.props.className, 'h');
    const width = sideFromClass(control.props.className, 'w');
    expect(height).toBeGreaterThanOrEqual(MIN_BOX_DP);
    expect(width).toBeGreaterThanOrEqual(MIN_BOX_DP);

    const slop = hitSlopPerSide(control.props.hitSlop);
    expect(height + 2 * slop).toBeGreaterThanOrEqual(MIN_REACH_DP);
    expect(width + 2 * slop).toBeGreaterThanOrEqual(MIN_REACH_DP);

    expect(control.props.accessibilityRole).toBe('button');
    unmount();
  });

  it('pushes the invite route when the control is pressed', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(OrganizationMembersScreen)
    );

    const control = findInviteControl(renderer.root)[0];
    if (!control) {
      throw new Error('invite control not found');
    }
    act(() => {
      (control.props.onPress as () => void)();
    });

    expect(routerPush).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/organization/invite-member');
    unmount();
  });

  it('keeps the invite control in place while skeletons swap to rows', async () => {
    withMembersQuery.isLoading = true;
    const loading = await renderWithProviders(createElement(OrganizationMembersScreen));
    const loadingControl = findInviteControl(loading.renderer.root)[0];
    if (!loadingControl) {
      throw new Error('invite control not found while loading');
    }
    const loadingClassName = loadingControl.props.className;
    loading.unmount();

    withMembersQuery.isLoading = false;
    withMembersQuery.data = {
      settings: {},
      members: [{ status: 'active', id: 'member-1', name: 'Ada', email: 'ada@example.com' }],
    };
    const loaded = await renderWithProviders(createElement(OrganizationMembersScreen));
    const loadedControl = findInviteControl(loaded.renderer.root)[0];
    if (!loadedControl) {
      throw new Error('invite control not found after loading');
    }

    expect(loadedControl.props.className).toBe(loadingClassName);
    loaded.unmount();
  });
});
