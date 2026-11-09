/* eslint-disable max-lines -- One suite covers the hub's rename control, its settings availability, the billing card's loading states and the Kilo Pass placeholder, all against the same mocked data layer and fixture. */
// The organization hub's rename control is icon-only. Before this slice it
// rendered a bare `<Pencil size={16} />`, so its accessibility node was the
// 16dp glyph and the audit read it below the 28dp floor. This suite pins the
// control to the shared IconButton box (>= 28dp per side, >= 44pt reach) and
// proves its tap opens the rename sheet. The role gate (`showMoney`) still
// decides whether the control exists at all.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only theme-token guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';

import { ORGANIZATION_NAME_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { createElement, isValidElement } from 'react';
import { act, type TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { compiledDimensions, compiledLengthDp } from '@/test/native-dimensions';

import { i18n } from '@/i18n';
import { AddCreditsRow } from '@/components/add-credits-row';
import { type OrgKiloPassRowState, type OrgKiloPassSummary } from './org-kilo-pass-row-state';
import { OrganizationHubScreen } from './hub-screen';

/** The smallest box the control-size audit accepts on a control's own node. */
const MIN_BOX_DP = 28;
/** DESIGN.md: the target every control must reach, in points. */
const MIN_REACH_DP = 44;
/** One Tailwind spacing unit, in dp. */
const SPACING_UNIT_DP = 4;

const boundary = vi.hoisted(() => ({
  role: 'owner' as string,
  name: 'Acme',
  parentOrganizationId: null as string | null | undefined,
  requireSeats: false,
  seatCount: { used: 1, total: 1 },
  balance: 5_000_000,
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
      organizationName: boundary.name,
      parentOrganizationId: boundary.parentOrganizationId,
      balance: boundary.balance,
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

// The hub obeys the Profile tab's hide-balance preference; this suite pins both
// renderings from a hoisted state each case sets.
const hideBalancePref = vi.hoisted(() => ({
  hideBalance: false,
  hasLoaded: true,
}));

vi.mock('@/lib/hooks/use-hide-balance-preference', () => ({
  useHideBalancePreference: () => ({
    hideBalance: hideBalancePref.hideBalance,
    hasLoaded: hideBalancePref.hasLoaded,
    setHideBalance: vi.fn(),
  }),
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

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// A suite that sets `current` pins the row state it needs; every other suite
// renders what the real mapper derives from the mocked payloads, including the
// loading state the row shows while the summary query has no data
// (`org-kilo-pass-row-state.ts`).
const kiloPassRowState = vi.hoisted(() => ({
  current: null as null | {
    subtitle: string;
    attention: boolean;
    action: 'manage' | 'setup' | 'retry' | 'none';
    actionLabel: string | null;
    accessibilityHint: string | null;
    loading: boolean;
  },
}));

vi.mock('@/components/organization/org-kilo-pass-row-state', async importOriginal => {
  const actual = (await importOriginal()) as {
    getOrgKiloPassRowState: (params: {
      data: OrgKiloPassSummary | undefined;
      isError: boolean;
    }) => OrgKiloPassRowState;
  };
  return {
    getOrgKiloPassRowState: (params: {
      data: OrgKiloPassSummary | undefined;
      isError: boolean;
    }): OrgKiloPassRowState => kiloPassRowState.current ?? actual.getOrgKiloPassRowState(params),
  };
});
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
  boundary.name = 'Acme';
  boundary.parentOrganizationId = null;
  boundary.requireSeats = false;
  boundary.seatCount = { used: 1, total: 1 };
  boundary.balance = 5_000_000;
  hideBalancePref.hideBalance = false;
  hideBalancePref.hasLoaded = true;
  kiloPassRowState.current = null;
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

  it('offers the top-up on the balance line of an empty balance', async () => {
    boundary.balance = 0;

    const { renderer, unmount } = await renderHub();

    const balance = renderer.root
      .findAllByType('KvRow')
      .find(node => node.props.label === i18n.t('organization.hub.balance'));
    // The control shares the amount's row: a row of its own held nothing but
    // the button once the copy beside it left.
    const trailing: object | null | undefined = balance?.props.trailing;
    expect(isValidElement(trailing) && trailing.type === AddCreditsRow).toBe(true);
    unmount();
  });

  it('keeps a funded organization on its balance line alone', async () => {
    const { renderer, unmount } = await renderHub();

    const balance = renderer.root
      .findAllByType('KvRow')
      .find(node => node.props.label === i18n.t('organization.hub.balance'));
    expect(balance?.props.value).toBe('$5');
    expect(balance?.props.trailing).toBeUndefined();
    unmount();
  });
});

describe('Organization hub balance masking', () => {
  // The mocked org carries balance 5_000_000 → the mocked formatMoney paints $5.
  const balanceRow = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root
      .findAllByType('KvRow')
      .find(node => node.props.label === i18n.t('organization.hub.balance'));

  it('paints the amount while the hide-balance preference is off', async () => {
    const { renderer, unmount } = await renderHub();

    const row = balanceRow(renderer);
    expect(row?.props.value).toBe('$5');
    // The spoken label always carries the amount: a node React Native stops
    // handing a label keeps its previous native value on Android, so the
    // masked-until-settled flip to visible must not leave "Balance hidden".
    expect(row?.props.valueAccessibilityLabel).toBe('$5');
    unmount();
  });

  it('masks the amount and speaks the hidden label while the preference is on', async () => {
    hideBalancePref.hideBalance = true;

    const { renderer, unmount } = await renderHub();

    const row = balanceRow(renderer);
    expect(row?.props.value).toBe('*****');
    expect(row?.props.valueAccessibilityLabel).toBe(i18n.t('profile.balanceHidden'));
    // No painted node may carry the amount while it is hidden.
    expect(
      renderer.root.findAll(
        node => typeof node.props.children === 'string' && node.props.children === '$5'
      )
    ).toHaveLength(0);
    unmount();
  });

  it('keeps the amount masked until the preference read settles', async () => {
    hideBalancePref.hideBalance = false;
    hideBalancePref.hasLoaded = false;

    const { renderer, unmount } = await renderHub();

    const row = balanceRow(renderer);
    expect(row?.props.value).toBe('*****');
    expect(row?.props.valueAccessibilityLabel).toBe(i18n.t('profile.balanceHidden'));
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

  it('opens the rename sheet on the whole stored name, up to the server limit', async () => {
    // `RenameModal`'s own default is shorter than a stored organization name can
    // be, and React Native applies `maxLength` to the seeded value: the dialog
    // then opens on a cut name, and saving keeps only what the field shows.
    const longName = 'Northwind Logistics — European Operations and Customer Support Berlin';
    expect(longName.length).toBeGreaterThan(50);
    boundary.name = longName;

    const { renderer, unmount } = await renderHub();
    const control = findRenameControl(renderer.root)[0];
    if (!control) {
      throw new Error('rename control not found');
    }
    act(() => {
      (control.props.onPress as () => void)();
    });

    const modal = renderer.root.findAll(node => String(node.type) === 'RenameModal')[0];
    expect(modal?.props).toMatchObject({
      initialValue: longName,
      maxLength: ORGANIZATION_NAME_MAX_LENGTH,
    });
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

describe('Organization hub Kilo Pass placeholder', () => {
  const loadingState = {
    subtitle: 'Loading…',
    attention: false,
    action: 'none',
    actionLabel: null,
    accessibilityHint: null,
    loading: true,
  } as const;

  function skeletonClasses(root: TestRenderer.ReactTestInstance): string[] {
    return root
      .findAll(node => String(node.type) === 'Skeleton')
      .map(node => String(node.props.className));
  }

  function subtitleNode(root: TestRenderer.ReactTestInstance, subtitle = 'Not subscribed') {
    return root.findAll(
      node => String(node.type) === 'Text' && node.props.children === subtitle
    )[0];
  }

  it('renders the loading bar on the subtitle line box, not above it', async () => {
    // Compile the box the subtitle actually lays out, from the class the screen
    // renders, then the bar's. Both go through the installed Tailwind and
    // react-native-css compilers, so this is the box the emulator paints rather
    // than a hand-written utility map. `h-3` (10.5dp) fails here: it drops the
    // text block below the 30dp icon tile and the whole row with it.
    kiloPassRowState.current = { ...loadingState, loading: false, subtitle: 'Not subscribed' };
    const loaded = await renderHub();
    const subtitleClass = String(subtitleNode(loaded.renderer.root)?.props.className);
    loaded.unmount();

    kiloPassRowState.current = { ...loadingState };
    const loading = await renderHub();
    const bar = skeletonClasses(loading.renderer.root)[0];
    loading.unmount();

    // `text-xs` carries a unitless line height (`calc(1 / 0.75)`), so its line
    // box is that multiple of the font size; both halves compile through the
    // installed Tailwind and react-native-css compilers, and the product is the
    // 14dp the emulator measures for a loaded subtitle. `h-3` (10.5dp) fails
    // here: it drops the text block below the 30dp icon tile and the row with it.
    const fontSize = await compiledLengthDp(subtitleClass, 'fontSize');
    const leading = await compiledLengthDp(subtitleClass, 'lineHeight');
    const lineBox = Math.round(fontSize * leading);
    // 1 rem at this app's 14-point rem: the height the row keeps in both states.
    expect(lineBox).toBe(14);

    if (bar === undefined) {
      throw new Error('Kilo Pass placeholder missing');
    }
    expect(Math.round(await compiledLengthDp(bar, 'height'))).toBe(lineBox);
  });

  it('paints the bar in the token that differs from the card it sits on', async () => {
    kiloPassRowState.current = { ...loadingState };

    const { renderer, unmount } = await renderHub();
    const classes = skeletonClasses(renderer.root)[0] ?? '';
    const tokens = classes.split(/\s+/).filter(Boolean);

    // `skeleton-fill` matches the `bg-secondary` row card in the light palette,
    // so the default bar drew nothing on this screen.
    expect(tokens).toContain('bg-muted-soft');
    expect(tokens).not.toContain('bg-muted');

    unmount();
  });

  it('swaps the bar for the status line once the summary resolves', async () => {
    kiloPassRowState.current = {
      subtitle: 'Not subscribed',
      attention: false,
      action: 'setup',
      actionLabel: null,
      accessibilityHint: null,
      loading: false,
    };

    const { renderer, unmount } = await renderHub();

    expect(skeletonClasses(renderer.root)).toHaveLength(0);
    const subtitle = renderer.root.findAll(
      node => String(node.type) === 'Text' && node.props.children === 'Not subscribed'
    );
    expect(subtitle).toHaveLength(1);
    expect(String(subtitle[0]?.props.className)).toContain('text-xs');

    unmount();
  });

  it('guards the theme tokens: bg-muted collides with the card, bg-muted-soft does not', () => {
    const css = readFileSync(new URL('../../global.css', import.meta.url), 'utf8');
    const values = (name: string) =>
      [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].map(match =>
        (match[1] ?? '').trim().toLowerCase()
      );
    const secondary = values('secondary');
    const muted = values('muted');
    const mutedSoft = values('muted-soft');

    // Both theme blocks are present.
    expect(secondary.length).toBeGreaterThanOrEqual(2);
    expect(muted).toHaveLength(secondary.length);
    expect(mutedSoft).toHaveLength(secondary.length);
    // The collision that made the default bar invisible on the organization
    // card, pinned so the token assertions above stay meaningful.
    expect(muted).toEqual(secondary);
    for (const [index, soft] of mutedSoft.entries()) {
      expect(soft).not.toBe(secondary[index]);
    }
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
    // The name is set in every state, so the node it produces changes with the
    // state instead of keeping the name it had while the value loaded.
    expect(bellRow(hub.renderer)?.props.accessibilityLabel).toBe(
      `${i18n.t('organization.lowBalanceAlert.title')}. ${i18n.t('common.off')}`
    );
    expect(kiloPassQuery.enabled.at(-1)).toBe(true);
    hub.unmount();

    membersQuery.data = undefined;
    const loading = await renderHub();
    // The Kilo Pass row used to appear only once the membership payload arrived.
    expect(loading.renderer.root.findAllByType('KiloPassIcon')).not.toEqual([]);
    // Loading copy is not a subtitle; the row reserves its settled line instead.
    expect(bellRow(loading.renderer)?.props.subtitle).toBeUndefined();
    expect(bellRow(loading.renderer)?.props.subtitlePlaceholder).toBeTruthy();
    // The placeholder has no text, so the row's name carries the loading state;
    // a reader hears the title and the cue instead of the bare title.
    expect(bellRow(loading.renderer)?.props.accessibilityLabel).toBe(
      `${i18n.t('organization.lowBalanceAlert.title')}. ${i18n.t('common.loading')}`
    );
    loading.unmount();

    // A failed membership read names the failure and the retry the row shows,
    // so the name never disagrees with the row it describes.
    membersQuery.isError = true;
    const failed = await renderHub();
    expect(bellRow(failed.renderer)?.props.accessibilityLabel).toBe(
      `${i18n.t('organization.lowBalanceAlert.title')}. ${i18n.t('common.somethingWentWrong')}. ${i18n.t('common.retry')}`
    );
    failed.unmount();
    membersQuery.isError = false;

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

  it('waits for the membership payload before asking for the parent-only summary', async () => {
    // A persisted list entry still says "top-level" while the organization has
    // since been moved under a parent, so the summary must not fire on that
    // cached value: the membership payload decides.
    membersQuery.data = undefined;
    const pending = await renderHub();
    expect(pending.renderer.root.findAllByType('KiloPassIcon')).not.toEqual([]);
    expect(kiloPassQuery.enabled.at(-1)).toBe(false);
    pending.unmount();

    membersQuery.data = { parent_organization_id: 'org-parent', settings: {} };
    const child = await renderHub();
    expect(child.renderer.root.findAllByType('KiloPassIcon')).toEqual([]);
    expect(kiloPassQuery.enabled.at(-1)).toBe(false);
    child.unmount();

    membersQuery.data = { parent_organization_id: null, settings: {} };
    const topLevel = await renderHub();
    expect(kiloPassQuery.enabled.at(-1)).toBe(true);
    topLevel.unmount();
  });

  it('offers the membership retry when the row cannot learn its parent link', async () => {
    boundary.parentOrganizationId = undefined;
    membersQuery.data = undefined;
    membersQuery.isError = true;
    const { renderer, unmount } = await renderHub();

    const row = renderer.root
      .findAll(node => String(node.type) === 'Pressable')
      .find(node => String(node.props.accessibilityLabel).startsWith(i18n.t('kiloPass.title')));
    if (!row) {
      throw new Error('Kilo Pass row missing');
    }
    // The retryable state, not the placeholder that would never settle.
    expect(row.props.accessibilityLabel).toBe(
      `${i18n.t('kiloPass.title')}. ${i18n.t('organization.kiloPass.couldNotLoadStatus')}. ${i18n.t('common.retry')}`
    );
    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(membersQuery.refetch).toHaveBeenCalledOnce();
    expect(kiloPassQuery.enabled.at(-1)).toBe(false);
    unmount();
  });
});

describe('Organization hub Kilo Pass icon tile', () => {
  /** The tile's own classes: the View that holds the Kilo Pass glyph. */
  function tileClass(root: TestRenderer.ReactTestInstance): string {
    const icon = root.findAllByType('KiloPassIcon')[0];
    if (icon === undefined) {
      throw new Error('Kilo Pass icon missing');
    }
    const tile = icon.parent;
    if (tile === null) {
      throw new Error('Kilo Pass tile missing');
    }
    return String(tile.props.className);
  }

  // The row stands beside ConfigureRows that carry no tone, so it takes the
  // shared neutral tile; a hue hashed from its title would put one accent in a
  // settings list. Attention is the only state that earns a tone.
  it('takes the neutral tile when the row needs no attention, never a hashed hue', async () => {
    kiloPassRowState.current = {
      subtitle: 'Not subscribed',
      attention: false,
      action: 'setup',
      actionLabel: 'Set up',
      accessibilityHint: 'Opens Kilo Pass setup on web.',
      loading: false,
    };
    const { renderer, unmount } = await renderHub();

    const tokens = tileClass(renderer.root).split(/\s+/).filter(Boolean);
    expect(tokens).toContain('bg-hair-soft');
    expect(tokens).toContain('border-border');
    expect(tokens.filter(token => token.startsWith('bg-agent-'))).toEqual([]);
    unmount();
  });

  it('keeps the warn tile for the attention state', async () => {
    kiloPassRowState.current = {
      subtitle: 'Could not load status',
      attention: true,
      action: 'retry',
      actionLabel: 'Retry',
      accessibilityHint: 'Retries loading Kilo Pass status.',
      loading: false,
    };
    const { renderer, unmount } = await renderHub();

    const tokens = tileClass(renderer.root).split(/\s+/).filter(Boolean);
    expect(tokens).toContain('bg-warn-tile-bg');
    expect(tokens).toContain('border-warn-tile-border');
    unmount();
  });
});
