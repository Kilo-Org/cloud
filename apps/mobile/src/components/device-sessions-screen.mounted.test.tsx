import { act } from '@/test/renderer';
import type * as ReactQuery from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DeviceSession } from '@/lib/device-sessions';
import { renderWithProviders } from '@/test/render-with-providers';
import { DeviceSessionsScreen } from './device-sessions-screen';
import { TrustedHostsScreen } from './trusted-hosts-screen';

const query = vi.hoisted(() => ({
  data: undefined as DeviceSession[] | undefined,
  isLoading: false,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const hosts = vi.hoisted(() => ({ trustedHosts: [] as string[], hasLoaded: true }));
const imageHosts = vi.hoisted(() => ({ trustedImageHosts: [] as string[], hasLoaded: true }));
const openExternalUrl = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ back: vi.fn(), dismissTo: vi.fn() }));
const confirmations = vi.hoisted(() => ({
  requests: [] as { title: string; message: string; confirmLabel: string }[],
}));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQuery: () => query,
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'DetailScreenScrollView' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: { title: string; message: string; confirmLabel: string }) => {
      confirmations.requests.push(request);
    },
    dialog: null,
  }),
}));
vi.mock('@/components/ui/icons', () => ({
  LogOut: 'LogOut',
  Smartphone: 'Smartphone',
  Shield: 'Shield',
  X: 'X',
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'test-token', signOut: vi.fn() }),
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://web.test' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => hosts,
  revokeHost: vi.fn(),
}));
// The trusted-hosts screen now reads a second SecureStore preference for image
// hosts; its real module pulls the secure-store -> sonner -> react-native chain
// the node test environment cannot load, so it is mocked beside the link list.
vi.mock('@/lib/hooks/use-trusted-image-hosts', () => ({
  useTrustedImageHosts: () => imageHosts,
  revokeImageHost: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      listDeviceSessions: { queryOptions: () => ({}) },
      revokeDeviceSessionById: { mutationOptions: () => ({}) },
    },
  }),
}));
vi.mock('@/lib/utils', () => ({ parseTimestamp: (value: string) => new Date(value) }));
vi.mock('@/lib/format', () => ({
  formatDate: (value: Date) => value.toISOString().slice(0, 10),
}));

beforeEach(() => {
  query.data = undefined;
  query.isLoading = false;
  query.isPending = false;
  query.isError = false;
  query.refetch.mockClear();
  openExternalUrl.mockClear();
  router.back.mockClear();
  router.dismissTo.mockClear();
  hosts.hasLoaded = true;
  hosts.trustedHosts = [];
  imageHosts.hasLoaded = true;
  imageHosts.trustedImageHosts = [];
  confirmations.requests = [];
});

describe('account surface states', () => {
  it.each(['empty', 'error'] as const)(
    'lifts the device %s state outside the scroller',
    async state => {
      query.isError = state === 'error';
      const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
      expect(
        renderer.root.findAll(node => String(node.type) === 'DetailScreenScrollView')
      ).toHaveLength(0);
      const body = renderer.root.find(
        node => String(node.type) === (state === 'error' ? 'QueryError' : 'EmptyState')
      );
      const props = body.props as { placement?: string; onRetry?: () => void };
      expect(props.placement).not.toBe('top');
      if (state === 'error') {
        props.onRetry?.();
        expect(query.refetch).toHaveBeenCalledOnce();
      }
      unmount();
    }
  );

  it('opens the web profile from the empty state', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    const emptyState = renderer.root.find(node => String(node.type) === 'EmptyState');
    // The mocked EmptyState receives the action as a prop element, not as a child.
    const action = emptyState.props.action as ReactElement<{ onPress: () => void }>;
    action.props.onPress();
    expect(openExternalUrl).toHaveBeenCalledWith('https://web.test/profile', expect.anything());
    unmount();
  });

  it('keeps cached device records after a refetch failure', async () => {
    query.isError = true;
    query.data = [
      {
        id: 'device-1',
        user_agent: 'Kilo/1',
        isCurrent: false,
        created_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z',
      },
    ];
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    const signOut = renderer.root.findAll(node => String(node.type) === 'Pressable');
    expect(signOut).toHaveLength(1);
    // The native rem is 14pt, so `min-h-11`/`min-w-11` is only 38.5pt — below
    // the app's 44pt minimum. The px form (what button.tsx and the image viewer
    // use) makes the visible box itself 44pt; hitSlop 8 keeps the effective
    // area larger still. The loading skeleton reserves this same box (asserted
    // below), so the taller control does not jump the list when rows arrive.
    expect(signOut[0]?.props.className).toContain('min-h-[44px]');
    expect(signOut[0]?.props.className).toContain('min-w-[44px]');
    expect(signOut[0]?.props.hitSlop).toBe(8);
    unmount();
  });

  it('keeps device loading ahead of error and empty states', async () => {
    query.isPending = true;
    query.isError = true;
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(12);
    // Every skeleton row reserves the sign-out control's final 44x44pt box, so
    // the loaded rows are the same height and the list does not jump on load.
    const reserved = renderer.root.findAll(
      node =>
        String(node.type) === 'View' &&
        String(node.props.className).includes('min-h-[44px]') &&
        String(node.props.className).includes('min-w-[44px]')
    );
    expect(reserved).toHaveLength(3);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    unmount();
  });

  // Regression: React Query v5's `isLoading` is false on the first render
  // before the observer starts fetching. The very first frame of a cold open
  // must still be the skeleton, not the empty state.
  it('shows the skeleton on the cold-open render before the request settles', async () => {
    query.isPending = true;
    query.isLoading = false;
    query.isError = false;
    query.data = undefined;
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(12);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    unmount();
  });

  it('lifts trusted host emptiness outside the scroller', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(TrustedHostsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'TabScreenScrollView')).toHaveLength(
      0
    );
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(1);
    unmount();
  });

  // The empty-state escape names the Preferences hub, so it must land there,
  // not one row short on Account (where the screen is pushed from).
  it('sends the empty-state escape to the Preferences hub', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(TrustedHostsScreen));
    const emptyState = renderer.root.find(node => String(node.type) === 'EmptyState');
    const action = emptyState.props.action as { props: { onPress: () => void } };
    act(() => {
      action.props.onPress();
    });
    expect(router.dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/preferences');
    expect(router.back).not.toHaveBeenCalled();
    unmount();
  });

  it('does not show trusted host emptiness before storage loads', async () => {
    hosts.hasLoaded = false;
    const { renderer, unmount } = await renderWithProviders(createElement(TrustedHostsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(4);
    unmount();
  });
});

const FIRST_STRONG_ISOLATE = '\u2068';
const POP_DIRECTIONAL_ISOLATE = '\u2069';

type SessionFixture = {
  id: string;
  userAgent: string;
  isCurrent?: boolean;
  signedIn?: string;
};

function session({
  id,
  userAgent,
  isCurrent = false,
  signedIn = '2026-01-01T00:00:00Z',
}: SessionFixture): DeviceSession {
  return {
    id,
    user_agent: userAgent,
    isCurrent,
    created_at: signedIn,
    last_seen_at: signedIn,
  };
}

describe('device session sign-out controls', () => {
  it('names the device in each non-current label and isolates it in the confirmation', async () => {
    query.data = [
      session({
        id: 'current',
        userAgent: 'Kilo-Code/1.2.3 (android)',
        isCurrent: true,
        signedIn: '2026-01-03T00:00:00Z',
      }),
      session({ id: 'phone', userAgent: 'هاتف-قديم', signedIn: '2026-02-28T09:15:00Z' }),
      session({ id: 'cli', userAgent: 'axios/1.7.0', signedIn: '2026-03-04T11:00:00Z' }),
    ];
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    const buttons = renderer.root.findAll(node => String(node.type) === 'Pressable');
    expect(buttons.map(button => button.props.accessibilityLabel)).toStrictEqual([
      'Sign out this device',
      `Sign out ${FIRST_STRONG_ISOLATE}هاتف-قديم${POP_DIRECTIONAL_ISOLATE}, signed in 2026-02-28`,
      `Sign out ${FIRST_STRONG_ISOLATE}axios${POP_DIRECTIONAL_ISOLATE}, signed in 2026-03-04`,
    ]);

    (buttons[1]?.props.onPress as (() => void) | undefined)?.();
    expect(confirmations.requests).toHaveLength(1);
    // The device name reorders the sentence it sits in unless it is isolated:
    // without the pair, an RTL run pulls the rest of the German line with it.
    expect(confirmations.requests[0]?.message).toBe(
      `${FIRST_STRONG_ISOLATE}هاتف-قديم${POP_DIRECTIONAL_ISOLATE} will be signed out. It can keep API access for up to an hour.`
    );

    const rowLabels = renderer.root.findAll(
      node =>
        String(node.type) === 'Text' &&
        typeof node.props.children === 'string' &&
        node.props.children.includes('هاتف-قديم')
    );
    expect(rowLabels.map(label => label.props.children)).toStrictEqual(['هاتف-قديم']);
    unmount();
  });

  // `deviceSessionLabel` collapses browser user agents and app sessions to one
  // name each, so two browsers would otherwise share a control label.
  it('keeps same-class sessions apart by their sign-in date', async () => {
    query.data = [
      session({
        id: 'browser-1',
        userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
        signedIn: '2026-03-10T08:00:00Z',
      }),
      session({
        id: 'browser-2',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
        signedIn: '2026-03-12T09:30:00Z',
      }),
    ];
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    const labels = renderer.root
      .findAll(node => String(node.type) === 'Pressable')
      .map(button => button.props.accessibilityLabel as string);
    expect(labels).toStrictEqual([
      `Sign out ${FIRST_STRONG_ISOLATE}Web browser${POP_DIRECTIONAL_ISOLATE}, signed in 2026-03-10`,
      `Sign out ${FIRST_STRONG_ISOLATE}Web browser${POP_DIRECTIONAL_ISOLATE}, signed in 2026-03-12`,
    ]);
    expect(new Set(labels).size).toBe(2);
    unmount();
  });
});
