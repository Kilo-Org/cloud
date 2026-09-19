// eslint-disable-next-line import/no-nodejs-modules -- the native CSS compiler's Node entry point is CommonJS
import { createRequire } from 'node:module';
import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as NativeCssCompiler from 'react-native-css/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { OrganizationHubScreen } from './hub-screen';

// The ESM compiler build imports a named `debug` export absent from its CJS dependency.
const loadCompiler = createRequire(import.meta.url);
const { compile } = loadCompiler('react-native-css/compiler') as typeof NativeCssCompiler;

const state = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  role: 'owner',
  org: null as {
    organizationName: string;
    balance: number;
    requireSeats: boolean;
    seatCount: { used: number; total: number };
  } | null,
  isResolving: false,
  isError: false,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: vi.fn() },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { language: 'en' } }));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  FileText: 'FileText',
  Pencil: 'Pencil',
  Receipt: 'Receipt',
  Users: 'Users',
}));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'Chevron' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: 'KvRow' }));
vi.mock('@/components/add-credits-row', () => ({ AddCreditsRow: 'AddCreditsRow' }));
vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/org-usage-stats', () => ({ OrgUsageStats: 'OrgUsageStats' }));
vi.mock('@/components/organization/org-kilo-pass-row-state', () => ({
  getOrgKiloPassRowState: () => null,
}));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.com' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/format', () => ({ formatMoney: String, formatNumber: String }));
vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => ({ rename: { mutateAsync: vi.fn() } }),
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: canManageOrganizationBilling,
  useOrgBoundary: () => state,
  useOrgWithMembers: () => ({ data: undefined }),
  useOrgKiloPassSummary: () => ({ data: undefined }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ setOrganizationId: vi.fn() }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

const mounted: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  state.organizationId = 'org-1';
  state.role = 'owner';
  state.org = {
    organizationName: 'Example organization',
    balance: 10_000_000,
    requireSeats: false,
    seatCount: { used: 1, total: 0 },
  };
  state.isResolving = false;
  state.isError = false;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

function mount(organizationIdOverride?: string) {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    holder.current = TestRenderer.create(
      <OrganizationHubScreen organizationIdOverride={organizationIdOverride} />
    );
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('OrganizationHubScreen did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

function renameButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByProps({
    accessibilityRole: 'button',
    accessibilityLabel: 'organization.hub.renameTitle',
  });
}

describe('organization rename target', () => {
  it('compiles the rendered target to at least 44 native units on each side', async () => {
    const renderer = mount();
    const button = renderer.root.findByProps({
      accessibilityLabel: 'organization.hub.renameTitle',
    });
    const classes = button.props.className as string;
    const css = await postcss([tailwindcss()]).process(
      `@import "tailwindcss" source(none); @source inline("${classes}");`,
      { from: 'src/global.css' }
    );
    const rules = compile(css.css).stylesheet().s;
    expect(rules).toEqual(
      expect.arrayContaining([
        ['h-[44px]', expect.arrayContaining([expect.objectContaining({ d: [{ height: 44 }] })])],
        ['w-[44px]', expect.arrayContaining([expect.objectContaining({ d: [{ width: 44 }] })])],
      ])
    );
  });

  it.each(['owner', 'admin', 'billing_manager'])(
    'reserves a non-shrinking 44dp target for %s, not just icon hit slop',
    role => {
      state.role = role;
      const renderer = mount();
      const [button] = renameButtons(renderer);
      expect(button).toBeDefined();
      expect(button?.props.className).toContain('h-[44px] w-[44px]');
      expect(button?.props.className).toContain('shrink-0');
      expect(button?.props.className).toContain('items-center justify-center');
      expect(button?.props.className).toContain('active:opacity-70');
      expect(button?.props.hitSlop).toBeUndefined();
      expect(button?.findByType('Pencil').props.size).toBe(16);
    }
  );

  it('keeps the compact row and truncates long names without shrinking the target', () => {
    if (state.org) {
      state.org.organizationName = 'A long organization name '.repeat(10);
    }
    const renderer = mount();
    const [button] = renameButtons(renderer);
    const row = button?.parent;
    expect(row?.props.className).toContain('min-h-[44px]');
    expect(row?.props.className).not.toContain('py-3');
    const name = row?.findByType('Text');
    expect(name?.props.className).toContain('flex-1');
    expect(name?.props.className).toContain('py-3');
    expect(name?.props.numberOfLines).toBe(1);
  });

  it('opens and dismisses the existing rename dialog from the enlarged target', () => {
    const renderer = mount();
    const button = renderer.root.findByProps({
      accessibilityLabel: 'organization.hub.renameTitle',
    });
    act(() => {
      (button.props.onPress as () => void)();
    });
    const modal = renderer.root.findByType('RenameModal');
    expect(modal.props.initialValue).toBe('Example organization');
    expect(modal.props.title).toBe('organization.hub.renameTitle');
    act(() => {
      (modal.props.onClose as () => void)();
    });
    expect(renderer.root.findAllByType('RenameModal')).toHaveLength(0);
    expect(renameButtons(renderer)).toHaveLength(1);
  });

  it('does not expose rename to a member', () => {
    state.role = 'member';
    expect(renameButtons(mount())).toHaveLength(0);
  });

  it.each(['loading', 'retryable error', 'unavailable', 'empty'])(
    'keeps rename absent and delegates the %s state to the organization boundary',
    scenario => {
      state.isResolving = scenario === 'loading';
      state.isError = scenario === 'retryable error';
      state.org = null;
      if (scenario === 'empty') {
        state.organizationId = null;
      }
      const renderer = mount();
      expect(renameButtons(renderer)).toHaveLength(0);
      expect(renderer.root.findByType('OrganizationBoundary').props.title).toBe(
        'common.organization'
      );
    }
  );

  it('preserves the access-denied boundary for a deep-linked organization', () => {
    state.org = null;
    const renderer = mount('inaccessible-org');
    expect(renameButtons(renderer)).toHaveLength(0);
    expect(renderer.root.findByType('OrganizationBoundary').props.organizationIdOverride).toBe(
      'inaccessible-org'
    );
  });
});
