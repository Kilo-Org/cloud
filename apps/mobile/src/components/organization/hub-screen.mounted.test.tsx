/* eslint-disable max-lines -- One suite covers the hub's rename control, its settings availability, and the billing card's loading states, all against the same mocked data layer. */
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
import { compiledDimensions } from '@/test/native-dimensions';

import { i18n } from '@/i18n';
import { OrganizationHubScreen } from './hub-screen';

/** The smallest box the control-size audit accepts on a control's own node. */
const MIN_BOX_DP = 28;
/** DESIGN.md: the target every control must reach, in points. */
const MIN_REACH_DP = 44;
/** One Tailwind spacing unit, in dp. */
const SPACING_UNIT_DP = 4;

const boundary = vi.hoisted(() => ({
  role: 'owner' as string,
  parentOrganizationId: null as string | null | undefined,
  requireSeats: false,
  seatCount: { used: 1, total: 1 },
}));
const routerPush = vi.hoisted(() => vi.fn());
const kiloPassQuery = vi.hoisted(() => ({ enabled: [] as boolean[] }));
const membersQuery = vi.hoisted(() => ({
  data: undefined as
    | { parent_organization_id: string | null; settings: { minimum_balance?: number } }
    | undefined,
  isLoading: false,
  isError: false,
  isPaused: false,
  refetch: vi.fn(),
}));

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
      parentOrganizationId: boundary.parentOrganizationId,
      balance: 5_000_000,
      requireSeats: boundary.requireSeats,
      seatCount: boundary.seatCount,
    },
    isResolving: false,
  }),
  useOrgWithMembers: () => membersQuery,
  useOrgKiloPassSummary: (_organizationId: string, enabled: boolean) => {
    kiloPassQuery.enabled.push(enabled);
    return { data: undefined, isError: false, refetch: vi.fn() };
  },
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

vi.mock('@/components/organization/org-usage-stats', () => ({ OrgUsageStats: 'OrgUsageStats' }));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: () => null,
}));

vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));

// The header is not what this suite measures, but the rename control now lives
// in its trailing slot, so the mock renders `headerRight` as its child instead
// of dropping it: the control keeps being found, measured and pressed below.
// `vi.mock` hoists this factory above the file's imports, so it imports
// `createElement` itself; a top-level import is not initialized yet here.
vi.mock('@/components/screen-header', async () => {
  const { createElement: h } = await import('react');
  return {
    ScreenHeader: ({ headerRight, title }: { headerRight?: React.ReactNode; title?: string }) =>
      h('ScreenHeader', { title }, headerRight),
  };
});

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
  Wallet: 'Wallet',
}));

vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));

// The Kilo Pass row's unresolved state renders the UI skeleton, whose real
// component reaches expo-linear-gradient and the reanimated worklets; neither
// is loaded in this project.
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

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
  boundary.parentOrganizationId = null;
  boundary.requireSeats = false;
  boundary.seatCount = { used: 1, total: 1 };
  routerPush.mockClear();
  kiloPassQuery.enabled = [];
  membersQuery.data = { parent_organization_id: null, settings: {} };
  membersQuery.isError = false;
  membersQuery.isPaused = false;
  membersQuery.refetch.mockClear();
});

describe('Organization hub card', () => {
  it('shows the organization name once, in the header beside the rename control', async () => {
    const { renderer, unmount } = await renderHub();

    const header = renderer.root.findAllByType('ScreenHeader')[0];
    expect(header?.props.title).toBe('Acme');
    // The card used to repeat the name in its first row, directly under a
    // header that already carried it.
    expect(renderer.root.findAll(node => node.props.children === 'Acme')).toHaveLength(0);
    unmount();
  });

  it('isolates the seat pair so a right-to-left layout cannot mirror it', async () => {
    boundary.requireSeats = true;
    boundary.seatCount = { used: 1, total: 5 };

    const { renderer, unmount } = await renderHub();

    const seats = renderer.root
      .findAllByType('KvRow')
      .find(node => node.props.label === i18n.t('organization.hub.organizationSeats'));
    // Left-to-right isolate (U+2066) and pop-directional-isolate (U+2069): the
    // pair reads 1 of 5 in either interface direction.
    expect(seats?.props.value).toBe('\u20661 / 5\u2069');
    unmount();
  });
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

  it('compiles the rename control box to at least 28dp with a 44pt reach', async () => {
    const { renderer, unmount } = await renderHub();

    const control = findRenameControl(renderer.root)[0];
    if (!control) {
      throw new Error('rename control not found');
    }

    // The audit reads the control's laid-out node and `hitSlop` never widens
    // it, so assert the box the installed Tailwind and react-native-css
    // compilers emit for the class, not a hand-written utility map.
    const declarations = (await compiledDimensions(control.props.className as string)) as {
      height?: number;
      width?: number;
    }[];
    const box = Object.assign({}, ...declarations) as { height: number; width: number };
    const slop = hitSlopPerSide(control.props.hitSlop);

    expect(box.height).toBeGreaterThanOrEqual(MIN_BOX_DP);
    expect(box.width).toBeGreaterThanOrEqual(MIN_BOX_DP);
    expect(box.height + 2 * slop).toBeGreaterThanOrEqual(MIN_REACH_DP);
    expect(box.width + 2 * slop).toBeGreaterThanOrEqual(MIN_REACH_DP);
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

describe('Organization hub settings availability', () => {
  it.each(['paused', 'failed'] as const)('retries unavailable settings when %s', async state => {
    membersQuery.data = undefined;
    membersQuery.isPaused = state === 'paused';
    membersQuery.isError = state === 'failed';
    const { renderer, unmount } = await renderHub();
    const row = renderer.root
      .findAllByType('ConfigureRow')
      .find(node => node.props.icon === 'Bell');
    if (!row) {
      throw new Error('Low-balance row missing');
    }
    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(membersQuery.refetch).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();
    unmount();
  });

  it('opens configuration with cached settings during a paused refetch failure', async () => {
    membersQuery.data = { parent_organization_id: null, settings: { minimum_balance: 15 } };
    membersQuery.isError = true;
    membersQuery.isPaused = true;
    const { renderer, unmount } = await renderHub();
    const row = renderer.root
      .findAllByType('ConfigureRow')
      .find(node => node.props.icon === 'Bell');
    if (!row) {
      throw new Error('Low-balance row missing');
    }
    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(routerPush).toHaveBeenCalledWith(
      '/(app)/(tabs)/(3_profile)/organization/low-balance-alert'
    );
    expect(membersQuery.refetch).not.toHaveBeenCalled();
    unmount();
  });
});

describe('Organization hub billing card while its data loads', () => {
  function bellRow(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root.findAllByType('ConfigureRow').find(node => node.props.icon === 'Bell');
  }

  it('keeps every row from the first frame and reserves the subtitle line', async () => {
    const hub = await renderHub();
    expect(bellRow(hub.renderer)?.props.subtitle).toBe(i18n.t('common.off'));
    expect(bellRow(hub.renderer)?.props.subtitlePlaceholder).toBeUndefined();
    expect(kiloPassQuery.enabled.at(-1)).toBe(true);
    hub.unmount();

    membersQuery.data = undefined;
    const loading = await renderHub();
    // The Kilo Pass row used to appear only once the membership payload arrived.
    expect(loading.renderer.root.findAllByType('KiloPassIcon')).not.toEqual([]);
    // Loading copy is not a subtitle; the row reserves its settled line instead.
    expect(bellRow(loading.renderer)?.props.subtitle).toBeUndefined();
    expect(bellRow(loading.renderer)?.props.subtitlePlaceholder).toBeTruthy();
    loading.unmount();

    // A list payload persisted before the parent link existed is unknown, not a
    // child, so the row is still there from the first frame.
    boundary.parentOrganizationId = undefined;
    const upgraded = await renderHub();
    expect(upgraded.renderer.root.findAllByType('KiloPassIcon')).not.toEqual([]);
    expect(kiloPassQuery.enabled.at(-1)).toBe(false);
    upgraded.unmount();

    // Either payload saying "child" removes the row and keeps the parent-only
    // summary query off.
    boundary.parentOrganizationId = 'org-parent';
    membersQuery.data = { parent_organization_id: null, settings: {} };
    const child = await renderHub();
    expect(child.renderer.root.findAllByType('KiloPassIcon')).toEqual([]);
    expect(kiloPassQuery.enabled.at(-1)).toBe(false);
    child.unmount();

    boundary.parentOrganizationId = undefined;
    membersQuery.data = { parent_organization_id: 'org-parent', settings: {} };
    const cachedChild = await renderHub();
    expect(cachedChild.renderer.root.findAllByType('KiloPassIcon')).toEqual([]);
    expect(kiloPassQuery.enabled.at(-1)).toBe(false);
    cachedChild.unmount();

    // A list entry that persisted "top-level" before the organization was moved
    // under a parent loses to the membership payload's parent id, instead of
    // summoning the parent-only summary until the list refetches.
    boundary.parentOrganizationId = null;
    membersQuery.data = { parent_organization_id: 'org-parent', settings: {} };
    const movedChild = await renderHub();
    expect(movedChild.renderer.root.findAllByType('KiloPassIcon')).toEqual([]);
    expect(kiloPassQuery.enabled.at(-1)).toBe(false);
    movedChild.unmount();

    // A `null` from the membership payload alone confirms a top-level entry
    // whose list entry predates the field, so its row settles without a refetch.
    boundary.parentOrganizationId = undefined;
    membersQuery.data = { parent_organization_id: null, settings: {} };
    const settled = await renderHub();
    expect(settled.renderer.root.findAllByType('KiloPassIcon')).not.toEqual([]);
    expect(kiloPassQuery.enabled.at(-1)).toBe(true);
    settled.unmount();
  });
});
