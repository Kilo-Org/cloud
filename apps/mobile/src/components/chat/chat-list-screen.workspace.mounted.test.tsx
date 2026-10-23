/* eslint-disable max-lines -- the account row is proven against the real account provider and picker, which needs the app's whole provider-mock surface in one file. */
import { createElement, type ReactNode } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ChatListScreen } from '@/components/chat/chat-list-screen';
import { OrganizationProvider } from '@/lib/organization-context';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

/**
 * Which workspace the Chat tab says it is showing.
 *
 * The list, the model catalogue and the empty state are all read for the active
 * account, so the tab has to name it: a person in two workspaces otherwise sees
 * their conversations disappear with nothing saying which workspace the empty
 * list belongs to. The row is the app's own account control, so these tests
 * mount it the way the app does — the real provider and the real picker — and
 * assert what the tab names, not how it is wired.
 */

const state = vi.hoisted(() => ({
  newChat: vi.fn<(place: unknown, target: unknown) => Promise<string>>(),
  push: vi.fn<(path: string) => void>(),
  toastError: vi.fn<(message: string, options?: unknown) => void>(),
  toastDismiss: vi.fn<(id?: string | number) => void>(),
  chats: [] as { sessionId: string; model: string; title: string; updatedAt: number }[],
  /** Every scope the list screen asked for chats in, newest last. */
  places: [] as { chatScope: string }[],
}));

const list = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));

const HAFENWERK = {
  organizationId: 'org-hafenwerk',
  organizationName: 'Hafenwerk Kunde',
  role: 'owner',
};
const NORDLICHT = {
  organizationId: 'org-nordlicht',
  organizationName: 'Nordlicht Agentur',
  role: 'member',
};

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ authEpoch: 0, token: 'token' }),
}));
vi.mock('@/lib/auth/logout-cleanup', () => ({
  unregisterActivityTokensAndTombstone: vi.fn(),
}));
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
// The chat store is what the scope row is *about*: the place the list is read
// for comes from the active account, exactly as `useChatPlace` derives it. The
// factory imports those modules dynamically because `vi.mock` factories are
// hoisted above this file's imports, so a static import would not be
// initialized yet.
vi.mock('@/lib/chat/use-chat', async () => {
  const { useOrganization } = await import('@/lib/organization-context');
  const { chatPlaceOf } = await import('@/lib/chat/scope');
  return {
    useChatPlace: () => chatPlaceOf('user-1', useOrganization().organizationId),
    newChat: state.newChat,
    useChatList: (place: { chatScope: string } | null) => {
      if (place !== null) {
        state.places.push(place);
      }
      return {
        chats: state.chats,
        isLoading: false,
        isError: false,
        refetch: () => undefined,
        remove: async () => {
          await Promise.resolve();
        },
        rename: async () => {
          await Promise.resolve();
        },
      };
    },
  };
});
vi.mock('@/lib/chat/layers', () => ({ rememberModelFacts: () => undefined }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    models: [{ id: 'm1', name: 'One', isPreferred: true }],
    isLoading: false,
    isError: false,
    refetch: () => undefined,
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#fff', mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/tab-bar-layout', () => ({ getEffectiveTabBarHeight: () => 0 }));
vi.mock('sonner-native', () => ({
  toast: { error: state.toastError, dismiss: state.toastDismiss },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native', () => ({
  // The picker's sheet is a native modal; honored like the real one so the
  // closed sheet renders nothing.
  Modal: (props: { visible?: boolean; children?: ReactNode }) =>
    props.visible ? createElement('Modal', null, props.children) : null,
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1, width: 400, height: 800 }),
}));
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));
vi.mock('@/components/agents/session-list-content', () => ({ FAB_MARGIN: 16, FAB_SIZE: 56 }));
vi.mock('@/components/centered-state-surface', () => ({
  StateSurfaceInsets: 'StateSurfaceInsets',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  MessageCircle: 'MessageCircle',
  Plus: 'Plus',
  Server: 'Server',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/chat/chat-row', () => ({ ChatRow: 'ChatRow' }));
vi.mock('@/components/chat/beta-pill', () => ({ BetaPill: 'BetaPill' }));
vi.mock('@/lib/chat/backend-store', () => ({ useChatBackends: () => [] }));
vi.mock('@/lib/chat/local-models', () => ({ useLocalModels: () => [] }));
vi.mock('@/lib/chat/gguf-models', () => ({
  useGgufModels: () => ({ models: [], download: null, failure: null }),
  ggufModelOptions: () => [],
}));
vi.mock('@/components/chat/backend-settings-sheet', () => ({
  BackendSettingsControl: 'BackendSettingsControl',
}));

const mounted: RenderWithProvidersResult[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  state.chats = [];
  state.places = [];
  list.mockReset().mockResolvedValue([HAFENWERK, NORDLICHT]);
  storage.read.mockReset().mockResolvedValue(HAFENWERK.organizationId);
  storage.write.mockReset().mockResolvedValue(undefined);
  storage.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

async function mount(): Promise<RenderWithProvidersResult> {
  const result = await renderWithProviders(createElement(ChatListScreen), {
    wrapper: OrganizationProvider,
  });
  mounted.push(result);
  return result;
}

/** The account control the tab shows, wherever on the screen it sits. */
function accountControl(ui: RenderWithProvidersResult) {
  return ui.renderer.root.findByProps({ accessibilityHint: 'Select account' });
}

/** The open picker's account rows, in option order. */
function optionRows(ui: RenderWithProvidersResult) {
  return ui.renderer.root.findAll(
    node => (node.type as string) === 'Pressable' && node.props.accessibilityRole === 'radio'
  );
}

async function press(node: ReactTestInstance): Promise<void> {
  const onPress = node.props.onPress as (() => void) | undefined;
  await act(() => {
    onPress?.();
  });
}

async function chooseAccount(ui: RenderWithProvidersResult, name: string): Promise<void> {
  await press(accountControl(ui));
  const row = optionRows(ui).find(node => node.props.accessibilityLabel === name);
  expect(row).toBeDefined();
  if (row !== undefined) {
    await press(row);
  }
}

describe('the workspace the Chat tab names', () => {
  it('names the active workspace above an empty list', async () => {
    const ui = await mount();

    await waitFor(() => accountControl(ui).props.accessibilityLabel === HAFENWERK.organizationName);

    // The row is what explains the empty state underneath it, so both are on
    // screen at once: an empty list with no workspace named is the finding.
    expect(ui.renderer.root.findAll(node => (node.type as string) === 'EmptyState')).toHaveLength(
      1
    );
    expect(accountControl(ui).props.accessibilityRole).toBe('button');
    expect(state.places.at(-1)?.chatScope).toBe(`user-1:${HAFENWERK.organizationId}`);
  });

  it('follows the workspace the reader switches to, with the list it scopes', async () => {
    const ui = await mount();
    await waitFor(() => accountControl(ui).props.accessibilityLabel === HAFENWERK.organizationName);

    await chooseAccount(ui, NORDLICHT.organizationName);

    await waitFor(() => accountControl(ui).props.accessibilityLabel === NORDLICHT.organizationName);
    // The name and the list cannot disagree: the screen is read for the
    // workspace the row just named.
    expect(state.places.at(-1)?.chatScope).toBe(`user-1:${NORDLICHT.organizationId}`);
    expect(storage.write).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY, NORDLICHT.organizationId);
  });

  it('names the personal scope when the account has no workspace', async () => {
    list.mockResolvedValue([]);
    storage.read.mockResolvedValue(null);
    const ui = await mount();

    await waitFor(() => accountControl(ui).props.accessibilityLabel === 'Personal');
    expect(state.places.at(-1)?.chatScope).toBe('user-1:personal');
  });
});
