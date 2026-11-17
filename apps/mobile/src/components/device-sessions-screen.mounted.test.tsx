import { act } from '@/test/renderer';
import type * as ReactQuery from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
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
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
// The layout primitives the screens compose: each mock renders the content the
// assertions read (the row's one-line title, its subtitle, and the control the
// row carries), at the geometry the real primitive owns.
vi.mock('@/components/ui/section', () => ({
  Section: ({ children }: { children?: ReactNode }): ReactNode => children,
}));
vi.mock('@/components/ui/row-group', () => ({
  RowGroup: ({ children }: { children?: ReactNode }): ReactNode => children,
}));
vi.mock('@/components/ui/row-skeleton', () => ({
  RowSkeleton: (props: { tile?: boolean; subtitle?: boolean }) =>
    createElement(
      'View',
      null,
      props.tile === true ? createElement('Skeleton') : null,
      createElement('Skeleton'),
      props.subtitle === true ? createElement('Skeleton') : null
    ),
}));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title: string; subtitle?: string; trailing?: ReactNode }) =>
    createElement(
      'View',
      null,
      createElement('Text', { numberOfLines: 1 }, props.title),
      props.subtitle === undefined ? null : createElement('Text', null, props.subtitle),
      props.trailing ?? null
    ),
}));
vi.mock('@/components/ui/icon-button', () => ({
  IconButton: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) =>
    createElement(
      'Pressable',
      { ...props, className: 'h-[48px] w-[48px] items-center justify-center' },
      props.children
    ),
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: { title: string; message: string; confirmLabel: string }) => {
      confirmations.requests.push(request);
    },
    dialog: null,
  }),
}));
vi.mock('@/components/ui/icons', () => ({
  Globe: 'Globe',
  Smartphone: 'Smartphone',
  Shield: 'Shield',
  X: 'X',
}));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalLogOut: 'DirectionalLogOut' }));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'test-token', signOut: vi.fn() }),
}));
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
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  parseTimestamp: (value: string) => new Date(value),
}));
vi.mock('@/lib/format', () => ({
  formatDate: (value: Date) => value.toISOString().slice(0, 10),
}));

beforeEach(() => {
  query.data = undefined;
  query.isLoading = false;
  query.isPending = false;
  query.isError = false;
  query.refetch.mockClear();
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
        renderer.root.findAll(node => String(node.type) === 'TabScreenScrollView')
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

  it('keeps cached device records after a refetch failure', async () => {
    query.isError = true;
    query.data = [
      {
        id: 'device-1',
        kind: 'other',
        platform: null,
        clientName: 'Kilo',
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
    // The control is the shared icon button: its own 48 dp box carries the
    // platform's minimum touch target, so the row needs no hit slop of its
    // own and the loading skeleton reserves the same row height.
    expect(signOut[0]?.props.className).toContain('h-[48px]');
    expect(signOut[0]?.props.className).toContain('w-[48px]');
    unmount();
  });

  it('keeps device loading ahead of error and empty states', async () => {
    query.isPending = true;
    query.isError = true;
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(9);
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
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(9);
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
  kind: DeviceSession['kind'];
  platform?: DeviceSession['platform'];
  clientName?: DeviceSession['clientName'];
  isCurrent?: boolean;
  signedIn?: string;
  lastSeen?: string;
};

function session({
  id,
  kind,
  platform = null,
  clientName = null,
  isCurrent = false,
  signedIn = '2026-01-01T00:00:00Z',
  lastSeen = signedIn,
}: SessionFixture): DeviceSession {
  return {
    id,
    kind,
    platform,
    clientName,
    isCurrent,
    created_at: signedIn,
    last_seen_at: lastSeen,
  };
}

describe('device session sign-out controls', () => {
  it('names the device and both dates in each non-current label and isolates the device in the confirmation', async () => {
    query.data = [
      session({
        id: 'current',
        kind: 'app',
        platform: 'android',
        isCurrent: true,
        signedIn: '2026-01-03T00:00:00Z',
      }),
      session({
        id: 'phone',
        kind: 'other',
        clientName: 'هاتف-قديم',
        signedIn: '2026-02-28T09:15:00Z',
        lastSeen: '2026-03-11T18:40:00Z',
      }),
      session({
        id: 'legacy-client',
        kind: 'other',
        clientName: 'axios',
        signedIn: '2026-03-04T11:00:00Z',
      }),
    ];
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    const buttons = renderer.root.findAll(node => String(node.type) === 'Pressable');
    expect(buttons.map(button => button.props.accessibilityLabel)).toStrictEqual([
      'Sign out this device',
      `Sign out ${FIRST_STRONG_ISOLATE}هاتف-قديم${POP_DIRECTIONAL_ISOLATE}, signed in 2026-02-28, last seen 2026-03-11`,
      `Sign out ${FIRST_STRONG_ISOLATE}axios${POP_DIRECTIONAL_ISOLATE}, signed in 2026-03-04, last seen 2026-03-04`,
    ]);

    (buttons[1]?.props.onPress as (() => void) | undefined)?.();
    expect(confirmations.requests).toHaveLength(1);
    // The device name reorders the sentence it sits in unless it is isolated:
    // without the pair, an RTL run pulls the rest of the German line with it.
    expect(confirmations.requests[0]?.message).toBe(
      `${FIRST_STRONG_ISOLATE}هاتف-قديم${POP_DIRECTIONAL_ISOLATE} will be signed out. Last seen 2026-03-11. It can keep API access for up to an hour.`
    );

    // Each row is titled by the client the server classified for it, so the
    // app row names its platform and no row shows a raw `user_agent` token.
    const rowTitles = renderer.root.findAll(
      node =>
        String(node.type) === 'Text' &&
        node.props.numberOfLines === 1 &&
        typeof node.props.children === 'string'
    );
    expect(rowTitles.map(title => title.props.children)).toStrictEqual([
      'Kilo app · Android',
      'هاتف-قديم',
      'axios',
    ]);
    unmount();
  });

  // Rows of one kind share a title, so two browsers would otherwise share a
  // control label too; the sign-in date keeps them apart.
  it('keeps same-class sessions apart by their sign-in date', async () => {
    query.data = [
      session({
        id: 'browser-1',
        kind: 'browser',
        signedIn: '2026-03-10T08:00:00Z',
        lastSeen: '2026-03-14T06:00:00Z',
      }),
      session({
        id: 'browser-2',
        kind: 'browser',
        signedIn: '2026-03-12T09:30:00Z',
        lastSeen: '2026-03-14T06:00:00Z',
      }),
    ];
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    const labels = renderer.root
      .findAll(node => String(node.type) === 'Pressable')
      .map(button => button.props.accessibilityLabel as string);
    expect(labels).toStrictEqual([
      `Sign out ${FIRST_STRONG_ISOLATE}Web browser${POP_DIRECTIONAL_ISOLATE}, signed in 2026-03-10, last seen 2026-03-14`,
      `Sign out ${FIRST_STRONG_ISOLATE}Web browser${POP_DIRECTIONAL_ISOLATE}, signed in 2026-03-12, last seen 2026-03-14`,
    ]);
    expect(new Set(labels).size).toBe(2);
    unmount();
  });
});
