/* eslint-disable max-lines -- the spend display and the action/role menus share the row's mounted harness. */
import { act, type ReactTestRenderer } from '@/test/renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatMoney } from '@/lib/format';
import { MemberRow } from './member-row';

type Mounted = RenderWithProvidersResult;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  impact: vi.fn(),
  notification: vi.fn(),
  confirm: vi.fn(),
  updateMember: { mutate: vi.fn() },
  removeMember: { mutate: vi.fn() },
  hookFactory: vi.fn(),
  menuProps: [] as Record<string, unknown>[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
  impactAsync: mocks.impact,
  notificationAsync: mocks.notification,
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm, dialog: null }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The refusal block imports the icon barrel; the real lucide deep imports
// cannot load in this project (see `vitest.setup.ts` for the same stubbing).
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#de0000' }),
}));
// The refusal block's message renders through AccessibleStatus; the studio
// mock above drops the announcement channel but keeps the message visible so
// the row's refusal copy stays assertable.
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: (props: Record<string, unknown>) =>
    props.message == null ? null : createElement('Text', props, props.message as string),
}));
vi.mock('@/components/ui/menu-sheet', () => ({
  MenuSheet: (props: Record<string, unknown>) => {
    mocks.menuProps.push(props);
    return null;
  },
}));
vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => mocks.hookFactory(),
}));

const member = {
  id: 'membership-1',
  name: 'Member E2E',
  email: 'member@example.com',
  role: 'member',
  dailyUsageLimitUsd: null,
  status: 'active',
} as unknown as Parameters<typeof MemberRow>[0]['member'];

const mounted: Mounted[] = [];

async function renderRow(overrides: Partial<Parameters<typeof MemberRow>[0]> = {}) {
  mocks.menuProps.length = 0;
  const view = await renderWithProviders(
    <MemberRow
      member={member}
      canManage
      canManageLimit
      callerRole="owner"
      enableUsageLimits
      isSalesDemo={false}
      organizationId="org-1"
      {...overrides}
    />
  );
  mounted.push(view);
  return view.renderer;
}

type MenuProps = {
  visible: boolean;
  title?: string;
  options: { label: string; destructive?: boolean; selected?: boolean }[];
  cancelLabel: string;
  onSelect: (index: number) => void;
  onClose: () => void;
  onDismiss: () => void;
  onRequestDismiss: () => boolean;
};

/**
 * The row renders the actions menu first and the role menu second; the mock
 * records every render, so the last two entries are the current pair.
 */
function menus(): MenuProps[] {
  return mocks.menuProps.slice(-2) as unknown as MenuProps[];
}

function actionsMenu(): MenuProps {
  const menu = menus()[0];
  if (!menu) {
    throw new Error('the actions menu was not rendered');
  }
  return menu;
}

function roleMenu(): MenuProps {
  const menu = menus()[1];
  if (!menu) {
    throw new Error('the role menu was not rendered');
  }
  return menu;
}

beforeEach(() => {
  mocks.push.mockReset();
  mocks.impact.mockReset();
  mocks.notification.mockReset();
  mocks.confirm.mockReset();
  mocks.updateMember.mutate.mockReset();
  mocks.removeMember.mutate.mockReset();
  mocks.hookFactory.mockReset();
  // Healthy mutations by default: updateMember and removeMember ride their
  // shared mutate mocks; every state read is false.
  mocks.hookFactory.mockImplementation(() => ({
    updateMember: { mutate: mocks.updateMember.mutate, isError: false, error: null },
    removeMember: { mutate: mocks.removeMember.mutate, isError: false, error: null },
  }));
});

// The row's rendered strings, whatever the block layout holds.
function textsOf(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findAllByType('Text').map(node => node.props.children as unknown);
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    act(() => {
      view.renderer.unmount();
    });
  }
});

describe('MemberRow menu', () => {
  it('opens the actions menu from the row without a native action sheet', async () => {
    const renderer = await renderRow();
    const row = renderer.root.findByType('Pressable');

    expect(actionsMenu().visible).toBe(false);
    expect(row.props.accessibilityLabel).toBe(
      i18n.t('organization.members.manageA11y', { name: 'Member E2E' })
    );

    await act(() => {
      (row.props.onPress as () => void)();
    });

    const menu = actionsMenu();
    expect(menu.visible).toBe(true);
    expect(menu.title).toBe('Member E2E');
    expect(menu.cancelLabel).toBe(i18n.t('common.cancel'));
    expect(menu.options.map(option => option.label)).toEqual([
      i18n.t('organization.members.changeRole'),
      i18n.t('organization.members.setDailyUsageLimit'),
      i18n.t('organization.members.removeMember'),
    ]);
    expect(menu.options[2]?.destructive).toBe(true);
    expect(menu.options[0]?.destructive).toBeUndefined();
  });

  it('offers an admin the daily limit alone on an owner row', async () => {
    const owner = { ...member, role: 'owner' } as unknown as Parameters<
      typeof MemberRow
    >[0]['member'];
    const renderer = await renderRow({ member: owner, canManage: false, canManageLimit: true });
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });

    expect(actionsMenu().visible).toBe(true);
    expect(actionsMenu().options.map(option => option.label)).toEqual([
      i18n.t('organization.members.setDailyUsageLimit'),
    ]);
  });

  it('offers a member-row manager every action in order', async () => {
    const renderer = await renderRow({ canManage: true, canManageLimit: true });
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });

    expect(actionsMenu().options.map(option => option.label)).toEqual([
      i18n.t('organization.members.changeRole'),
      i18n.t('organization.members.setDailyUsageLimit'),
      i18n.t('organization.members.removeMember'),
    ]);
  });

  it('renders no menu when the caller may run no action', async () => {
    const renderer = await renderRow({ canManage: false, canManageLimit: false });

    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(
      renderer.root.findAllByType('Text').map(node => node.props.children as unknown)
    ).toContain('Member E2E');
  });

  it('hides the daily-limit option when usage limits are off', async () => {
    const renderer = await renderRow({ enableUsageLimits: false });
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });
    expect(actionsMenu().options.map(option => option.label)).toEqual([
      i18n.t('organization.members.changeRole'),
      i18n.t('organization.members.removeMember'),
    ]);
  });

  it('opens the daily-limit sheet route once the menu is gone', async () => {
    const renderer = await renderRow();
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });
    await act(() => {
      actionsMenu().onSelect(1);
    });

    // The route waits for the dismiss animation, so a Back press during it can
    // still cancel the open instead of racing the route it would push.
    expect(actionsMenu().visible).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();

    await act(() => {
      actionsMenu().onDismiss();
    });

    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
      '/(app)/(tabs)/(3_profile)/organization/member-limit?memberId=membership-1'
    );
    expect(mocks.updateMember.mutate).not.toHaveBeenCalled();
  });

  it('drops the chosen action when the menu dismisses itself while closing', async () => {
    const renderer = await renderRow();
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });
    await act(() => {
      actionsMenu().onSelect(1);
    });
    await act(() => {
      expect(actionsMenu().onRequestDismiss()).toBe(true);
    });
    await act(() => {
      actionsMenu().onDismiss();
    });

    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('asks before removing a member and keeps the menu closed after selection', async () => {
    const renderer = await renderRow();
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });
    await act(() => {
      actionsMenu().onSelect(2);
    });
    await act(() => {
      actionsMenu().onDismiss();
    });

    expect(actionsMenu().visible).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();

    const confirmArgs = mocks.confirm.mock.calls[0]?.[0] as { onConfirm: () => void };
    await act(() => {
      confirmArgs.onConfirm();
    });
    expect(mocks.removeMember.mutate).toHaveBeenCalledExactlyOnceWith(
      { memberId: 'membership-1' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('moves to the role menu and applies the chosen role', async () => {
    const renderer = await renderRow();
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });
    await act(() => {
      actionsMenu().onSelect(0);
    });
    await act(() => {
      actionsMenu().onDismiss();
    });

    expect(actionsMenu().visible).toBe(false);
    expect(roleMenu().visible).toBe(true);
    expect(roleMenu().title).toBe(i18n.t('organization.members.changeRole'));
    expect(roleMenu().options.map(option => option.selected)).toEqual([false, false, true, false]);
    expect(roleMenu().options.map(option => option.label)).toEqual([
      i18n.t('organization.members.roles.owner'),
      i18n.t('organization.members.roles.admin'),
      i18n.t('organization.members.roles.member'),
      i18n.t('organization.members.roles.billingManager'),
    ]);

    await act(() => {
      roleMenu().onSelect(1);
    });
    expect(roleMenu().visible).toBe(false);
    expect(mocks.updateMember.mutate).not.toHaveBeenCalled();
    await act(() => {
      roleMenu().onDismiss();
    });
    expect(mocks.updateMember.mutate).toHaveBeenCalledExactlyOnceWith(
      { memberId: 'membership-1', role: 'admin' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('offers an admin every role but owner, which the server reserves for owners', async () => {
    const renderer = await renderRow({ callerRole: 'admin' });
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });
    await act(() => {
      actionsMenu().onSelect(0);
    });
    await act(() => {
      actionsMenu().onDismiss();
    });

    expect(roleMenu().options.map(option => option.label)).toEqual([
      i18n.t('organization.members.roles.admin'),
      i18n.t('organization.members.roles.member'),
      i18n.t('organization.members.roles.billingManager'),
    ]);
  });

  it('closes the menu without navigating when it is dismissed', async () => {
    const renderer = await renderRow({ enableUsageLimits: false });
    await act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });
    await act(() => {
      actionsMenu().onClose();
    });

    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.updateMember.mutate).not.toHaveBeenCalled();
    expect(mocks.removeMember.mutate).not.toHaveBeenCalled();
  });

  // The hook is mocked per test, so a refusal is driven by returning a failed
  // mutation object for the hook call this render makes.
  function hookMutations(overrides: {
    updateMember?: Partial<{
      isError: boolean;
      error: unknown;
      mutateAsync: unknown;
      reset: () => void;
    }>;
    removeMember?: Partial<{
      isError: boolean;
      error: unknown;
      mutateAsync: unknown;
      reset: () => void;
    }>;
  }) {
    return {
      updateMember: { mutate: mocks.updateMember.mutate, ...overrides.updateMember },
      removeMember: { mutate: mocks.removeMember.mutate, ...overrides.removeMember },
    };
  }

  it('renders the mapped refusal on the row when the server refuses the role change', async () => {
    mocks.hookFactory.mockImplementation(() =>
      hookMutations({
        updateMember: {
          isError: true,
          error: { data: { code: 'FORBIDDEN', message: 'Organization trial has expired.' } },
        },
      })
    );
    const view = await renderRow();

    expect(textsOf(view)).toContain(i18n.t('common.organizationTrialEnded'));
  });

  it('states a refused removal carried by the screen, after the row remounted', async () => {
    const view = await renderRow({
      removalFailure: { kind: 'removal-refused', message: 'Organization trial has expired.' },
    });

    expect(textsOf(view)).toContain('Organization trial has expired.');
  });

  it('publishes the removal refusal to the screen attempt and abandons on success', async () => {
    let settled: { kind: string; message: string } | undefined = undefined;
    let abandoned = false;
    const onRemovalStarted = vi.fn(() => ({
      owns: () => true,
      succeed: () => true,
      fail: (failure: { kind: string; message: string }) => {
        settled = failure;
        return true;
      },
      abandon: () => {
        abandoned = true;
        return true;
      },
    }));
    mocks.hookFactory.mockImplementation(
      () =>
        hookMutations({
          removeMember: {
            // A recognized server sentence must arrive mapped, not as the
            // generic fallback: the fallback copy would also satisfy a bare
            // restore, so this rejection tells the two paths apart.
            mutateAsync: vi.fn().mockRejectedValueOnce({
              data: { code: 'FORBIDDEN', message: 'Organization trial has expired.' },
            }),
          },
        }) as never
    );
    mocks.confirm.mockImplementation((request: { title: string; onConfirm: () => void }) => {
      request.onConfirm();
    });
    const view = await renderRow({ onRemovalStarted });
    await act(() => {
      (view.root.findByType('Pressable').props.onPress as () => void)();
    });
    // Remove member is the actions menu's third row; the confirm mock confirms
    // in place, so the attempt starts when the confirm lands.
    await act(() => {
      actionsMenu().onSelect(2);
    });
    await act(() => {
      actionsMenu().onDismiss();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onRemovalStarted).toHaveBeenCalledWith('membership-1');
    // The mapped sentence for the recognized server message, not the generic
    // fallback: this is what tells the mapping from a bare restore.
    expect(settled).toEqual({
      kind: 'removal-refused',
      message: i18n.t('common.organizationTrialEnded'),
    });
    expect(abandoned).toBe(false);
  });

  it('renders no refusal block while the mutations are healthy', async () => {
    mocks.hookFactory.mockImplementation(() => hookMutations({}));
    const view = await renderRow();

    expect(textsOf(view)).not.toContain(i18n.t('common.organizationTrialEnded'));
  });

  it('gives a newer removal the row the refused role change no longer describes', async () => {
    let resetCalls = 0;
    mocks.hookFactory.mockImplementation(() =>
      hookMutations({
        updateMember: {
          isError: true,
          error: { data: { code: 'FORBIDDEN', message: 'Organization trial has expired.' } },
          // The row resets the sticky role-change error to retire the refusal
          // its newer removal supersedes. The count reads the call, not the
          // property: the reset must run when the removal supersedes the
          // refusal, not when this mock is wired.
          reset: () => {
            resetCalls += 1;
          },
        },
        removeMember: {
          mutateAsync: vi.fn().mockReturnValue(new Promise(() => undefined)),
        },
      })
    );
    mocks.confirm.mockImplementation((request: { title: string; onConfirm: () => void }) => {
      request.onConfirm();
    });
    const view = await renderRow({
      onRemovalStarted: () => ({
        owns: () => true,
        succeed: () => true,
        fail: () => true,
        abandon: () => true,
      }),
    });
    await act(() => {
      (view.root.findByType('Pressable').props.onPress as () => void)();
    });
    await act(() => {
      actionsMenu().onSelect(2);
    });
    await act(() => {
      actionsMenu().onDismiss();
    });

    expect(textsOf(view)).toContain(i18n.t('common.organizationTrialEnded'));
    expect(resetCalls).toBe(1);
  });
});

describe('MemberRow daily spend', () => {
  // The same fields web's `DailyUsageLimitDisplay` pairs, and only in the
  // states it pairs them in.
  const spendMember = {
    ...member,
    dailyUsageLimitUsd: 10,
    currentDailyUsageUsd: 2.4,
  } as unknown as Parameters<typeof MemberRow>[0]['member'];

  const texts = (renderer: Awaited<ReturnType<typeof renderRow>>) =>
    renderer.root.findAllByType('Text').map(node => node.props.children as unknown);

  const pair = `${isolateLtrBidiText(formatMoney(2.4, i18n.language))} / ${isolateLtrBidiText(
    formatMoney(10, i18n.language)
  )}`;
  const limitOnly = i18n.t('organization.members.limitPerDay', {
    amount: isolateLtrBidiText(formatMoney(10, i18n.language)),
  });

  it('pairs spend with the limit for a sales-demo organization', async () => {
    const renderer = await renderRow({ member: spendMember, isSalesDemo: true });
    expect(texts(renderer)).toContain(pair);
    expect(texts(renderer)).not.toContain(limitOnly);
  });

  it('keeps the limit alone for an organization web does not pair', async () => {
    const renderer = await renderRow({ member: spendMember, isSalesDemo: false });
    expect(texts(renderer)).toContain(limitOnly);
    expect(texts(renderer)).not.toContain(pair);
  });

  it('keeps the limit alone when the server withholds the spend', async () => {
    const stripped = { ...member, dailyUsageLimitUsd: 10 } as unknown as Parameters<
      typeof MemberRow
    >[0]['member'];
    const renderer = await renderRow({ member: stripped, isSalesDemo: true });
    expect(texts(renderer)).toContain(limitOnly);
    expect(texts(renderer)).not.toContain(pair);
  });

  it('shows no spend line for a member without a daily limit', async () => {
    const unlimited = { ...member, currentDailyUsageUsd: 2.4 } as unknown as Parameters<
      typeof MemberRow
    >[0]['member'];
    const renderer = await renderRow({ member: unlimited, isSalesDemo: true });
    expect(texts(renderer)).not.toContain(pair);
    expect(
      texts(renderer).some(
        value => typeof value === 'string' && value.includes(formatMoney(10, i18n.language))
      )
    ).toBe(false);
  });
});
