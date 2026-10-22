import { createElement, type ElementType, type ReactNode } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrReviewContextLine } from './pr-review-context-line';
import { OrganizationProvider } from '@/lib/organization-context';
import { ORGANIZATION_PERSONAL_STORAGE_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const auth = vi.hoisted(() => ({ token: 'token' as string | undefined }));

// The mounted OrganizationProvider announces a lost-membership switch through
// the toast adapter, whose module graph reaches react-native's Flow source the
// mounted transform cannot parse. The mock sits at the adapter, so the visual
// toast package never loads here.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

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
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', ChevronDown: 'ChevronDown' }));
// `Skeleton` and `ActivityIndicator` pull `@/lib/a11y/motion` →
// `expo-battery` → `__DEV__`; the line never renders either, so string stubs
// cut the chain.
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));

const Text = 'Text' as ElementType;
const Pressable = 'Pressable' as ElementType;
const ChevronDown = 'ChevronDown' as ElementType;

const ORG_A = { organizationId: 'org-a', organizationName: 'Acme', role: 'owner' };
const ORG_B = { organizationId: 'org-b', organizationName: 'Umbrella', role: 'member' };

const mounted: RenderWithProvidersResult[] = [];

async function mount(): Promise<RenderWithProvidersResult> {
  const result = await renderWithProviders(createElement(PrReviewContextLine), {
    wrapper: OrganizationProvider,
  });
  mounted.push(result);
  return result;
}

function texts(ui: RenderWithProvidersResult) {
  return ui.renderer.root.findAll(node => node.type === Text).flatMap(node => node.children);
}

function line(ui: RenderWithProvidersResult) {
  const nodes = ui.renderer.root.findAll(node => node.props.accessibilityHint === 'Select account');
  return nodes[0] as ReactTestInstance | undefined;
}

async function press(node: ReactTestInstance) {
  const onPress = node.props.onPress as () => void;
  await act(() => {
    onPress();
  });
}

beforeEach(() => {
  auth.token = 'token';
  list.mockReset().mockResolvedValue([ORG_A, ORG_B]);
  storage.read.mockReset().mockResolvedValue(null);
  storage.write.mockReset().mockResolvedValue(undefined);
  storage.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('PrReviewContextLine', () => {
  it('names the active organization from the memberships list', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => texts(ui).includes('For Acme'));
    expect(texts(ui)).toContain('For Acme');
  });

  it('names the personal scope when the personal marker is stored', async () => {
    // The mock's `read` is a plain vi.fn; restore() awaits whatever it
    // returns, so a synchronous marker value is enough here.
    storage.read.mockImplementation((key: string) =>
      key === ORGANIZATION_PERSONAL_STORAGE_KEY ? 'personal' : null
    );
    const ui = await mount();
    await waitFor(() => texts(ui).includes('For your personal account'));
    expect(texts(ui)).toContain('For your personal account');
  });

  it('switches organization through the picker sheet', async () => {
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    await waitFor(() => texts(ui).includes('For Acme'));

    const control = line(ui);
    if (!control) {
      throw new Error('the context line is not switchable');
    }
    await press(control);

    // The sheet is open: the picker rows render with radio roles.
    const rows = ui.renderer.root.findAll(
      node => node.type === Pressable && node.props.accessibilityRole === 'radio'
    );
    expect(rows.map(row => row.props.accessibilityLabel)).toEqual(['Personal', 'Acme', 'Umbrella']);

    const umbrella = rows.find(row => row.props.accessibilityLabel === 'Umbrella');
    if (!umbrella) {
      throw new Error('the Umbrella row is missing from the picker');
    }
    await press(umbrella);
    await waitFor(() => texts(ui).includes('For Umbrella'));
    expect(storage.write).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'org-b');
  });

  it('renders plain text with no chevron when there is nothing to switch to', async () => {
    list.mockResolvedValue([]);
    const ui = await mount();
    await waitFor(() => texts(ui).includes('For your personal account'));
    expect(line(ui)).toBeUndefined();
    expect(ui.renderer.root.findAllByType(ChevronDown)).toHaveLength(0);
  });

  it('falls back to the generic noun while the memberships list resolves', async () => {
    const { promise } = Promise.withResolvers<never>();
    list.mockReturnValue(promise);
    // The provider publishes the first list entry as the default; with the
    // list pending the line shows the generic noun until it lands.
    storage.read.mockResolvedValue('org-a');
    const ui = await mount();
    expect(texts(ui)).toContain('For Organization');
  });

  it('shows the instance hint on a second line when given', async () => {
    storage.read.mockResolvedValue('org-a');
    const result = await renderWithProviders(
      createElement(PrReviewContextLine, { instanceHint: 'https://gitlab.example.com' }),
      { wrapper: OrganizationProvider }
    );
    mounted.push(result);
    await waitFor(() => texts(result).includes('For Acme'));
    expect(texts(result)).toContain('https://gitlab.example.com');
  });

  it('offers a retry when the memberships query fails', async () => {
    storage.read.mockResolvedValue('org-a');
    list.mockRejectedValue(new Error('list failed'));
    const ui = await mount();
    await waitFor(
      () => ui.renderer.root.findAll(node => node.props.accessibilityLabel === 'Retry').length > 0
    );

    expect(texts(ui)).toContain('For Organization');
    const retry = ui.renderer.root.find(node => node.props.accessibilityLabel === 'Retry');
    list.mockResolvedValue([ORG_A, ORG_B]);
    await press(retry);
    await waitFor(() => texts(ui).includes('For Acme'));
  });

  it('offers a retry on the personal scope when the memberships query fails', async () => {
    list.mockRejectedValue(new Error('list failed'));
    const ui = await mount();
    await waitFor(() => texts(ui).includes('For your personal account'));
    const retry = ui.renderer.root.find(node => node.props.accessibilityLabel === 'Retry');
    list.mockResolvedValue([ORG_A, ORG_B]);
    await press(retry);
    // A personal selection persists across the failed first load, so the
    // recovery brings back the switcher rather than an organization label.
    await waitFor(() => ui.renderer.root.findAllByType(ChevronDown).length > 0);
    expect(line(ui)).toBeDefined();
  });

  it('recovers a persisted organization that left the list to the first membership', async () => {
    storage.read.mockResolvedValue('gone-org');
    const ui = await mount();
    // The first settled list omits the stored organization, so the provider
    // switches to the first membership and persists it instead of naming a
    // dead selection the reader cannot act on.
    await waitFor(() => texts(ui).includes('For Acme'));
    expect(texts(ui)).not.toContain('Organization unavailable');
    expect(storage.write).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, 'org-a');
  });
});
