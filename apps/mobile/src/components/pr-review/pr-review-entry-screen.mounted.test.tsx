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

// The inbox is the surface that decides which connection a review link opens
// under, so the context line has to mount there for real: `pr-review-entry-
// screen.test.ts` runs the screen as a plain function and can only see a
// same-named host stub. This suite renders the screen, and the context line
// inside it, through the real renderer.

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
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
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

const Text = 'Text' as ElementType;
const Pressable = 'Pressable' as ElementType;
const ScreenHeader = 'ScreenHeader' as ElementType;
const PrReviewInboxList = 'PrReviewInboxList' as ElementType;

const mounted: RenderWithProvidersResult[] = [];

async function mount(): Promise<RenderWithProvidersResult> {
  const result = await renderWithProviders(createElement(PrReviewEntryScreen), {
    wrapper: OrganizationProvider,
  });
  mounted.push(result);
  return result;
}

function orderOf(ui: RenderWithProvidersResult, match: (node: ReactTestInstance) => boolean) {
  return ui.renderer.root.findAll(() => true).findIndex(node => match(node));
}

function contextLineCopy(ui: RenderWithProvidersResult) {
  return ui.renderer.root
    .findAll(node => node.type === Text)
    .flatMap(node => node.children)
    .filter(child => typeof child === 'string' && child.startsWith('For '));
}

async function press(node: ReactTestInstance) {
  const onPress = node.props.onPress as () => void;
  await act(() => {
    onPress();
  });
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

describe('PrReviewEntryScreen context line', () => {
  it('names the active organization between the header and the inbox', async () => {
    const ui = await mount();
    await waitFor(() => contextLineCopy(ui).includes('For Acme'));

    const header = orderOf(ui, node => node.type === ScreenHeader);
    const line = orderOf(ui, node => node.type === Text && node.children.includes('For Acme'));
    const inbox = orderOf(ui, node => node.type === PrReviewInboxList);

    expect(header).toBeGreaterThanOrEqual(0);
    expect(line).toBeGreaterThan(header);
    expect(inbox).toBeGreaterThan(line);
  });

  it('switches organization from the inbox line through the picker sheet', async () => {
    const ui = await mount();
    await waitFor(() => contextLineCopy(ui).includes('For Acme'));

    const control = ui.renderer.root.findAll(
      node => node.props.accessibilityHint === 'Select account'
    )[0];
    if (!control) {
      throw new Error('the context line is not switchable in the inbox');
    }
    await press(control);

    const rows = ui.renderer.root.findAll(
      node => node.type === Pressable && node.props.accessibilityRole === 'radio'
    );
    expect(rows.map(row => row.props.accessibilityLabel)).toEqual(['Personal', 'Acme', 'Umbrella']);

    const umbrella = rows.find(row => row.props.accessibilityLabel === 'Umbrella');
    if (!umbrella) {
      throw new Error('the Umbrella row is missing from the picker');
    }
    await press(umbrella);
    await waitFor(() => contextLineCopy(ui).includes('For Umbrella'));
    expect(storage.write).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'org-b');
  });
});
