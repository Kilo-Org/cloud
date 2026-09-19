// The org hub's "Rename organization" pencil is one of the icon-only controls
// the accessibility explorer found below 28dp: it rendered the bare 16dp icon,
// so its accessibility node was the icon. Both routes that show the hub
// (organization/index and the organization/[org-id] deep link) render this same
// control, so this suite covers both.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { expectReliableTapTarget } from '@/test/touch-target.test-helpers';

import '@/i18n';
import { OrganizationHubScreen } from './hub-screen';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  FileText: 'FileText',
  Pencil: 'Pencil',
  Receipt: 'Receipt',
  Users: 'Users',
}));

vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));

vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));

vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }) =>
    createElement('TabScreenScrollView', null, props.children),
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string }) => createElement('ScreenHeader', null, props.title),
}));

vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));

vi.mock('@/components/add-credits-row', () => ({ AddCreditsRow: 'AddCreditsRow' }));

vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));

vi.mock('@/components/organization/org-usage-stats', () => ({ OrgUsageStats: 'OrgUsageStats' }));

vi.mock('@/components/organization/org-kilo-pass-row-state', () => ({
  getOrgKiloPassRowState: () => null,
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.ai' }));

vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => ({ rename: { mutateAsync: vi.fn() } }),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => true,
  useOrgBoundary: () => ({
    organizationId: 'org-1',
    role: 'owner',
    org: {
      organizationName: 'Acme',
      balance: 0,
      requireSeats: false,
      seatCount: { used: 1, total: 1 },
    },
    isResolving: false,
  }),
  useOrgWithMembers: () => ({
    data: { parent_organization_id: null, settings: { minimum_balance: null }, members: [] },
  }),
  useOrgKiloPassSummary: () => ({ data: undefined, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666', foreground: '#000000' }),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ setOrganizationId: vi.fn() }),
}));

async function renderHub(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(OrganizationHubScreen));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findRenameControl(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Rename organization'
  );
}

describe('OrganizationHubScreen rename control', () => {
  it('gives the rename control a box at least 28dp on a side and a 44pt tap target', async () => {
    const renderer = await renderHub();

    expectReliableTapTarget(findRenameControl(renderer.root).props);
  });

  it('still opens the rename modal from the control', async () => {
    const renderer = await renderHub();

    act(() => {
      (findRenameControl(renderer.root).props.onPress as () => void)();
    });

    expect(renderer.root.findAll(node => String(node.type) === 'RenameModal')).toHaveLength(1);
  });
});
