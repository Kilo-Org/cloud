import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { act } from '@/test/renderer';
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
const router = vi.hoisted(() => ({ back: vi.fn() }));
const focusEffects = vi.hoisted(() => ({
  run: [] as (() => void)[],
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useFocusEffect: (effect: () => void) => {
    focusEffects.run.push(effect);
  },
}));
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
const mutationsApi = vi.hoisted(() => ({
  invite: {
    reset: vi.fn(),
    mutate: vi.fn(),
    isError: false,
    isPending: false,
    error: null as { message: string } | null,
  },
  updateMember: { mutate: vi.fn() },
}));
vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => mutationsApi,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ email: 'test@example.com' }),
}));

beforeEach(() => {
  router.back.mockClear();
  focusEffects.run = [];
  mutationsApi.invite.reset.mockClear();
  mutationsApi.invite.mutate.mockClear();
  mutationsApi.invite.isError = false;
  mutationsApi.invite.isPending = false;
  mutationsApi.invite.error = null;
  mutationsApi.updateMember.mutate.mockClear();
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

  it('invite sheet starts every focus clean: resets mutation state and form state', async () => {
    // The sheet's own render pipeline mocks `react-native` to strings, so
    // `renderWithProviders` for the full sheet works with the same harness
    // the other invite assertions use.
    mutationsApi.invite.isError = true;
    mutationsApi.invite.error = { message: 'That invitation failed' };
    const { renderer, unmount } = await renderWithProviders(createElement(InviteMemberSheet));

    // The open sheet still shows its own inline mutation error.
    expect(JSON.stringify(renderer.toJSON())).toContain('That invitation failed');

    // A focus run (every open, first included) clears it and the form state.
    expect(focusEffects.run).toHaveLength(1);
    const focusRun = focusEffects.run[0];
    if (!focusRun) {
      throw new Error('focus effect was not captured');
    }
    mutationsApi.invite.isError = false;
    mutationsApi.invite.error = null;
    await act(() => {
      focusRun();
    });
    expect(mutationsApi.invite.reset).toHaveBeenCalledOnce();
    // The re-render the reset schedules clears the inline error.
    await waitFor(() => !JSON.stringify(renderer.toJSON()).includes('That invitation failed'));
    expect(JSON.stringify(renderer.toJSON())).not.toContain('That invitation failed');
    unmount();
  });

  it('invite sheet refuses submit while the send gate is closed', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(InviteMemberSheet));
    const closedGateRun = focusEffects.run[0];
    if (!closedGateRun) {
      throw new Error('focus effect was not captured');
    }
    closedGateRun();
    const button = renderer.root.find(node => String(node.type) === 'Button');
    const { onPress } = button.props as { onPress?: () => void };
    expect(onPress).toBeDefined();
    // The gate is closed (no typing happened): submit must be a no-op.
    if (onPress) {
      onPress();
    }
    expect(mutationsApi.invite.mutate).not.toHaveBeenCalled();
    unmount();
  });
});
