import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { InviteMemberSheet } from './invite-member-sheet';
import { LowBalanceAlertSheet } from './low-balance-alert-sheet';
import { MemberLimitSheet } from './member-limit-sheet';

const boundary = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  role: 'owner',
  org: null as { organizationId: string } | null,
  isResolving: false,
}));
const query = vi.hoisted(() => ({
  data: undefined as { members: { id: string; status: string }[]; settings: object } | undefined,
  isLoading: false,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/member-row', () => ({ roleLabel: String }));
vi.mock('@/components/organization/invited-member-row-state', () => ({
  getInviteSuccessMessage: () => '',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', Lock: 'Lock' }));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { success: vi.fn() } }));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  ORGANIZATION_MEMBER_INVITED_EVENT: 'invited',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => boundary,
  useOrgWithMembers: () => query,
  isActiveOrgMember: (member: { status: string }) => member.status === 'active',
  isMoneyRole: (role: string) => role === 'owner' || role === 'billing_manager',
}));
vi.mock('@/lib/hooks/use-organization-mutations', () => ({ useOrganizationMutations: () => ({}) }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ email: 'test@example.com' }),
}));

beforeEach(() => {
  boundary.organizationId = 'org-1';
  boundary.org = { organizationId: 'org-1' };
  boundary.role = 'owner';
  boundary.isResolving = false;
  query.data = undefined;
  query.isLoading = false;
  query.isPending = false;
  query.isError = false;
  query.refetch.mockClear();
});

const sheets = [
  { name: 'member limit', element: createElement(MemberLimitSheet, { memberId: 'member-1' }) },
  { name: 'low balance alert', element: createElement(LowBalanceAlertSheet) },
];

describe('organization sheet surfaces', () => {
  it.each(sheets)('lifts the $name error outside the form scroller', async ({ element }) => {
    query.isError = true;
    const { renderer, unmount } = await renderWithProviders(element);
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    const props = error.props as { placement?: string; onRetry: () => void };
    expect(props.placement).not.toBe('top');
    props.onRetry();
    expect(query.refetch).toHaveBeenCalledOnce();
    expect(renderer.toJSON()).toHaveLength(2);
    unmount();
  });

  it('centers a missing member without nesting the state in a scroller', async () => {
    query.data = { members: [], settings: {} };
    const { renderer, unmount } = await renderWithProviders(
      createElement(MemberLimitSheet, { memberId: 'missing' })
    );
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    unmount();
  });

  it.each([...sheets, { name: 'invite', element: createElement(InviteMemberSheet) }])(
    'keeps the $name context boundary outside a scroller',
    async ({ element }) => {
      boundary.organizationId = null;
      boundary.org = null;
      const { renderer, unmount } = await renderWithProviders(element);
      expect(
        renderer.root.findAll(node => String(node.type) === 'OrganizationBoundary')
      ).toHaveLength(1);
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      unmount();
    }
  );

  it.each([...sheets, { name: 'invite', element: createElement(InviteMemberSheet) }])(
    'keeps $name permission denial outside a scroller',
    async ({ element }) => {
      boundary.role = 'member';
      const { renderer, unmount } = await renderWithProviders(element);
      expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(1);
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      unmount();
    }
  );
});
