import type * as ReactQuery from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DeviceSession } from '@/lib/device-sessions';
import { renderWithProviders } from '@/test/render-with-providers';
import { DeviceSessionsScreen } from './device-sessions-screen';
import { TrustedHostsScreen } from './trusted-hosts-screen';

const query = vi.hoisted(() => ({
  data: undefined as DeviceSession[] | undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const hosts = vi.hoisted(() => ({ trustedHosts: [] as string[], hasLoaded: true }));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQuery: () => query,
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }));
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
vi.mock('@/components/ui/icons', () => ({
  LogOut: 'LogOut',
  Smartphone: 'Smartphone',
  Shield: 'Shield',
  X: 'X',
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'test-token', signOut: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => hosts,
  revokeHost: vi.fn(),
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
vi.mock('@/lib/format', () => ({ formatDate: () => 'Date' }));

beforeEach(() => {
  query.data = undefined;
  query.isLoading = false;
  query.isError = false;
  query.refetch.mockClear();
  hosts.hasLoaded = true;
  hosts.trustedHosts = [];
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
    expect(renderer.root.findAll(node => String(node.type) === 'Pressable')).toHaveLength(1);
    unmount();
  });

  it('keeps device loading ahead of error and empty states', async () => {
    query.isLoading = true;
    query.isError = true;
    const { renderer, unmount } = await renderWithProviders(createElement(DeviceSessionsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(12);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
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

  it('does not show trusted host emptiness before storage loads', async () => {
    hosts.hasLoaded = false;
    const { renderer, unmount } = await renderWithProviders(createElement(TrustedHostsScreen));
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(4);
    unmount();
  });
});
