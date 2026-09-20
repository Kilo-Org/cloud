// The organization hub's rename control is icon-only. Before this slice it
// rendered a bare `<Pencil size={16} />`, so its accessibility node was the
// 16dp glyph and the audit read it below the 28dp floor. This suite pins the
// control to the shared IconButton box (>= 28dp per side, >= 44pt reach) and
// proves its tap opens the rename sheet. The role gate (`showMoney`) still
// decides whether the control exists at all.

import { createElement } from 'react';
import { act, type TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { OrganizationHubScreen } from './hub-screen';

/** The smallest box the control-size audit accepts on a control's own node. */
const MIN_BOX_DP = 28;
/** DESIGN.md: the target every control must reach, in points. */
const MIN_REACH_DP = 44;
/** One Tailwind spacing unit, in dp. */
const SPACING_UNIT_DP = 4;

const boundary = vi.hoisted(() => ({ role: 'owner' as string }));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@kilocode/app-shared/utils', () => ({
  fromMicrodollars: (microdollars: number) => microdollars / 1_000_000,
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: (role: string) => role === 'owner' || role === 'admin',
  useOrgBoundary: () => ({
    organizationId: 'org-1',
    role: boundary.role,
    org: {
      organizationId: 'org-1',
      organizationName: 'Acme',
      balance: 5_000_000,
      requireSeats: false,
      seatCount: { used: 1, total: 1 },
    },
    isResolving: false,
  }),
  useOrgWithMembers: () => ({
    data: { parent_organization_id: null, settings: {} },
    isLoading: false,
    isError: false,
  }),
  useOrgKiloPassSummary: () => ({ data: undefined, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => ({ rename: { mutateAsync: vi.fn() } }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: 'gray', foreground: 'black' }),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1', setOrganizationId: vi.fn() }),
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.test' }));

vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/format', () => ({
  formatMoney: (amount: number) => `$${amount}`,
  formatNumber: String,
}));

vi.mock('@/lib/agent-color', () => ({
  agentColor: () => ({}),
  toneColor: () => ({}),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/components/organization/org-kilo-pass-row-state', () => ({
  getOrgKiloPassRowState: () => null,
}));

vi.mock('@/components/organization/org-usage-stats', () => ({ OrgUsageStats: 'OrgUsageStats' }));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: () => null,
}));

vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));

vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

vi.mock('@/components/add-credits-row', () => ({ AddCreditsRow: 'AddCreditsRow' }));

vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));

vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));

vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));

vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  FileText: 'FileText',
  Pencil: 'Pencil',
  Receipt: 'Receipt',
  Users: 'Users',
}));

vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

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

function findRenameControl(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Rename organization'
  );
}

async function renderHub() {
  const { renderer, unmount } = await renderWithProviders(createElement(OrganizationHubScreen));
  return { renderer, unmount };
}

beforeEach(() => {
  boundary.role = 'owner';
  routerPush.mockClear();
});

describe('OrganizationHubScreen rename control', () => {
  it('renders the rename control with at least a 28dp box and a 44pt reach', async () => {
    const { renderer, unmount } = await renderHub();

    const controls = findRenameControl(renderer.root);
    expect(controls).toHaveLength(1);
    const control = controls[0];
    if (!control) {
      throw new Error('rename control not found');
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

  it('opens the rename sheet when the control is pressed', async () => {
    const { renderer, unmount } = await renderHub();

    expect(renderer.root.findAll(node => String(node.type) === 'RenameModal')).toHaveLength(0);

    const control = findRenameControl(renderer.root)[0];
    if (!control) {
      throw new Error('rename control not found');
    }
    act(() => {
      (control.props.onPress as () => void)();
    });

    expect(renderer.root.findAll(node => String(node.type) === 'RenameModal')).toHaveLength(1);
    unmount();
  });

  it('hides the control for a non-billing member while the screen still renders', async () => {
    boundary.role = 'member';

    const { renderer, unmount } = await renderHub();

    expect(findRenameControl(renderer.root)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'KvRow').length).toBeGreaterThan(0);
    unmount();
  });
});
