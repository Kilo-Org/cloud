import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { act, type TestRenderer } from '@/test/renderer';
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
  data: undefined as
    | {
        members: {
          id: string;
          status: string;
          name?: string | null;
          email?: string | null;
          dailyUsageLimitUsd?: number | null;
        }[];
        settings: object;
      }
    | undefined,
  isLoading: false,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
  // None of these surfaces needs a focus effect to run, and the invite sheet
  // resets its form on every focus after mount, so running one per render
  // would loop.
  useFocusEffect: () => undefined,
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
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
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
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
const mutations = vi.hoisted(() => {
  const updateMember = {
    mutate: vi.fn(),
    isError: false,
    isPending: false,
    error: null as Error | null,
  };
  return {
    updateMember,
    current: {
      invite: { isPending: false, isError: false, mutate: vi.fn(), reset: vi.fn() },
      updateMember,
    },
  };
});
const updateMember = mutations.updateMember;
vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => mutations.current,
}));
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
  updateMember.mutate.mockClear();
  updateMember.isError = false;
  updateMember.isPending = false;
  updateMember.error = null;
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

  it('keeps Cancel usable on an empty invite, so the sheet can be left', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(InviteMemberSheet));
    const header = renderer.root.find(node => String(node.type) === 'SheetHeader');
    // The stub keeps the component's own props untyped; only these two are read.
    const headerProps = header.props as { disabled?: boolean; doneDisabled?: boolean };
    // The route no longer dismisses by a swipe, so an empty form must still be
    // closeable through Cancel.
    expect(headerProps.disabled).toBe(false);
    expect(headerProps.doneDisabled).toBe(true);
    unmount();
  });

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

async function mountLimitForm(dailyUsageLimitUsd: number | null) {
  query.data = {
    members: [
      {
        id: 'member-1',
        status: 'active',
        name: 'Dana Member',
        email: 'dana@example.com',
        dailyUsageLimitUsd,
      },
    ],
    settings: {},
  };
  const mounted = await renderWithProviders(
    createElement(MemberLimitSheet, { memberId: 'member-1' })
  );
  return mounted;
}

function propsOf(instance: TestRenderer.ReactTestInstance): Record<string, unknown> {
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return instance.props as Record<string, unknown>;
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function formField(renderer: TestRenderer.ReactTestRenderer): Record<string, unknown> {
  return propsOf(renderer.root.find(node => String(node.type) === 'FormField'));
}

function saveButton(renderer: TestRenderer.ReactTestRenderer): Record<string, unknown> {
  const [save] = renderer.root.findAll(node => String(node.type) === 'Button');
  if (!save) {
    throw new Error('the limit form rendered no save button');
  }
  return propsOf(save);
}

const rangeMessage = i18n.t('organization.memberLimit.rangeError', {
  max: formatNumber(2000, i18n.language),
});
const blankWithoutLimitMessage = i18n.t('organization.memberLimit.blankWithoutLimitError', {
  max: formatNumber(2000, i18n.language),
});

describe('MemberLimitSheet validation', () => {
  it('shows the range error on an above-maximum amount and keeps save disabled', async () => {
    const { renderer, unmount } = await mountLimitForm(1200);

    expect(formField(renderer).error).toBeUndefined();
    expect(saveButton(renderer).disabled).toBe(false);

    act(() => {
      (formField(renderer).onChangeText as (value: string) => void)('2500');
    });

    expect(formField(renderer).error).toBe(rangeMessage);
    expect(saveButton(renderer).disabled).toBe(true);
    unmount();
  });

  it('clears the error and re-enables save once the amount is back in range', async () => {
    const { renderer, unmount } = await mountLimitForm(1200);

    act(() => {
      (formField(renderer).onChangeText as (value: string) => void)('2500');
    });
    act(() => {
      (formField(renderer).onChangeText as (value: string) => void)('900');
    });

    expect(formField(renderer).error).toBeUndefined();
    expect(saveButton(renderer).disabled).toBe(false);
    unmount();
  });

  it('explains a blank field on a member with no limit only after interaction', async () => {
    const { renderer, unmount } = await mountLimitForm(null);

    expect(formField(renderer).error).toBeUndefined();
    expect(saveButton(renderer).disabled).toBe(true);

    act(() => {
      (formField(renderer).onBlur as () => void)();
    });

    expect(formField(renderer).error).toBe(blankWithoutLimitMessage);
    expect(saveButton(renderer).disabled).toBe(true);
    unmount();
  });
});
