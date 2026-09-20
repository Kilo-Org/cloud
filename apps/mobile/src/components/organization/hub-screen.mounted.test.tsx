// The on-device accessibility explorer measures a control's laid-out bounds and
// `hitSlop` never widens them: the org-name row's icon-only rename Pressable is
// read as its 16pt glyph and reported too small to tap. This mounts the real
// screen JSX (queries mocked) and pins the compiled box.

import { createElement } from 'react';
import { compiledDimensions } from '@/test/native-dimensions';
import { renderWithProviders } from '@/test/render-with-providers';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { OrganizationHubScreen } from './hub-screen';

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => true,
  useOrgBoundary: () => ({
    organizationId: 'org-1',
    role: 'owner',
    org: {
      organizationId: 'org-1',
      organizationName: 'Engineering',
      requireSeats: true,
      seatCount: { used: 3, total: 5 },
      balance: 0,
    },
    isResolving: false,
  }),
  useOrgWithMembers: () => ({
    data: { parent_organization_id: null, settings: { minimum_balance: 5 } },
    isLoading: false,
    isError: false,
  }),
  useOrgKiloPassSummary: () => ({ data: undefined, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/components/organization/org-kilo-pass-row-state', () => ({
  getOrgKiloPassRowState: () => null,
}));

vi.mock('@/lib/hooks/use-organization-mutations', () => ({
  useOrganizationMutations: () => ({ rename: { mutateAsync: vi.fn() } }),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ setOrganizationId: vi.fn() }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: () => null,
}));
vi.mock('@/components/rename-modal', () => ({ RenameModal: () => null }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'View' }));
vi.mock('@/components/add-credits-row', () => ({ AddCreditsRow: () => null }));
vi.mock('@/components/organization/org-usage-stats', () => ({ OrgUsageStats: () => null }));
vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: () => null }));
vi.mock('@/components/ui/kv-row', () => ({ KvRow: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
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

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.ai' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/format', () => ({
  formatMoney: (amount: number) => `$${amount}`,
  formatNumber: String,
}));
vi.mock('@/lib/agent-color', () => ({
  agentColor: () => ({ tileBgClass: '', tileBorderClass: '', hueThemeKey: 'foreground' }),
  toneColor: () => ({ tileBgClass: '', tileBorderClass: '', hueThemeKey: 'foreground' }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#777777' }),
}));
vi.mock('@kilocode/app-shared/utils', () => ({
  fromMicrodollars: (microdollars: number) => microdollars / 1_000_000,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));

describe('OrganizationHubScreen rename control', () => {
  it('lays out a box at least 28dp on a side', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(OrganizationHubScreen));
    const rename = renderer.root.find(
      node =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Rename organization'
    );
    const declarations = (await compiledDimensions(rename.props.className as string)) as {
      height?: number;
      width?: number;
    }[];
    const box = Object.assign({}, ...declarations) as { height: number; width: number };

    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height + 2 * (rename.props.hitSlop as number)).toBeGreaterThanOrEqual(44);
    unmount();
  });
});
