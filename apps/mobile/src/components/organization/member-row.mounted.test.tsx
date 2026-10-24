import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { i18n } from '@/i18n';
import { MemberRow } from './member-row';

type Mounted = RenderWithProvidersResult;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  impact: vi.fn(),
  notification: vi.fn(),
  confirm: vi.fn(),
  updateMember: { mutate: vi.fn() },
  removeMember: { mutate: vi.fn() },
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
vi.mock('@/components/ui/menu-sheet', () => ({
  MenuSheet: (props: Record<string, unknown>) => {
    mocks.menuProps.push(props);
    return null;
  },
}));
vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => ({
    updateMember: mocks.updateMember,
    removeMember: mocks.removeMember,
  }),
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
    <MemberRow member={member} canManage enableUsageLimits organizationId="org-1" {...overrides} />
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
});

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
});
