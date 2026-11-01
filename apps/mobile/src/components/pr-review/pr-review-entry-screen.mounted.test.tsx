import { createElement, type ElementType, type ReactNode } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrReviewEntryScreen } from './pr-review-entry-screen';
import { OrganizationProvider } from '@/lib/organization-context';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const auth = vi.hoisted(() => ({ token: 'token' as string | undefined }));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth }));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: storage.read,
  setItemAsync: storage.write,
  deleteItemAsync: storage.remove,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations-list'], queryFn: list }) },
    },
  }),
}));
vi.mock('expo-router', () => ({
  useRouter: () => navigation,
  // The recent-PR read on focus is not under test here; the recents section
  // stays in its loading state.
  useFocusEffect: vi.fn(),
}));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/pr-review/recent-prs', () => ({
  getRecentPrs: vi.fn().mockResolvedValue([]),
  removeRecentPr: vi.fn(),
  recentPrKey: () => 'recent-key',
  providerRefFromRecentPr: () => ({ platform: 'github', owner: 'kilo', repo: 'cloud', number: 1 }),
}));
vi.mock('react-native', () => ({
  // Sheet registers the app-level Android Back listener while it is visible.
  BackHandler: { addEventListener: vi.fn(() => ({ remove: () => undefined })) },
  Modal: (props: { visible?: boolean; children?: ReactNode }) =>
    props.visible ? createElement('Modal', null, props.children) : null,
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 18 }),
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }) =>
    createElement('ScreenHeader', null, props.headerRight),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  Clipboard: 'Clipboard',
  SearchX: 'SearchX',
  X: 'X',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/pr-review/pr-review-inbox-list', () => ({
  PrReviewInboxList: 'PrReviewInboxList',
  // The screen composes the section break under its paste block, so the mock
  // must answer it; the behaviour under test is not the spacing value.
  PR_REVIEW_SECTION_BREAK: { room: 'min-h-6', padding: 'pt-6' },
}));
vi.mock('@/components/pr-review/pr-link-placeholder', () => ({
  PrLinkPlaceholder: 'PrLinkPlaceholder',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: vi.fn() } }));

const ORG_A = { organizationId: 'org-a', organizationName: 'Acme', role: 'owner' };
const ORG_B = { organizationId: 'org-b', organizationName: 'Umbrella', role: 'member' };

const Pressable = 'Pressable' as ElementType;

const mounted: RenderWithProvidersResult[] = [];

async function mount(): Promise<RenderWithProvidersResult> {
  const result = await renderWithProviders(createElement(PrReviewEntryScreen), {
    wrapper: OrganizationProvider,
  });
  mounted.push(result);
  return result;
}

async function press(node: ReactTestInstance) {
  const onPress = node.props.onPress as () => void;
  await act(() => {
    onPress();
  });
}

/** The selected state an account action button carries, if it carries one. */
function selectedState(node: ReactTestInstance): boolean | undefined {
  const state: unknown = node.props.accessibilityState;
  if (typeof state !== 'object' || state === null || !('selected' in state)) {
    return undefined;
  }
  return typeof state.selected === 'boolean' ? state.selected : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.token = 'token';
  list.mockReset().mockResolvedValue([ORG_A, ORG_B]);
  storage.read.mockReset().mockResolvedValue('org-a');
  storage.write.mockReset().mockResolvedValue(undefined);
  storage.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('PrReviewEntryScreen account picker', () => {
  it('switches organization through the header picker', async () => {
    const ui = await mount();
    await waitFor(
      () => ui.renderer.root.findAll(node => node.props.accessibilityLabel === 'Acme').length > 0
    );

    const control = ui.renderer.root.findAll(
      node => node.props.accessibilityHint === 'Select account'
    )[0];
    if (!control) {
      throw new Error('the account picker is not switchable');
    }
    await press(control);

    const rows = ui.renderer.root.findAll(
      node =>
        node.type === Pressable &&
        node.props.accessibilityRole === 'button' &&
        selectedState(node) !== undefined
    );
    expect(rows.map(row => row.props.accessibilityLabel)).toEqual(['Personal', 'Acme', 'Umbrella']);

    const umbrella = rows.find(row => row.props.accessibilityLabel === 'Umbrella');
    if (!umbrella) {
      throw new Error('the Umbrella row is missing from the picker');
    }
    await press(umbrella);
    await waitFor(
      () =>
        ui.renderer.root.findAll(
          node =>
            node.props.accessibilityLabel === 'Umbrella' &&
            node.props.accessibilityHint === 'Select account'
        ).length > 0
    );
    expect(storage.write).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'org-b');
  });
});
