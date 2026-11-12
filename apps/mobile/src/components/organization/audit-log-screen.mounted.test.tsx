/* eslint-disable max-lines -- cohesive mounted suite for the audit-log screen state contract */

// Audit-log screen state contract: the billing-role/enterprise gate, the first
// page's skeleton, a retryable first-page error, the empty state, the paged list
// with its `hasMore` footer, and a later-page failure that keeps the rows it has.
// The query layer is mocked so each state is driven directly through the screen
// JSX, the same way the credit-activity suite does it.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { OrganizationAuditLogScreen } from './audit-log-screen';

const pageQuery = {
  isPending: false,
  isError: false,
  isFetchNextPageError: false,
  isFetching: false,
  isFetchingNextPage: false,
  data: null as unknown,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
};

const pageHook = {
  entries: [] as unknown[],
  hasMore: false,
};

const boundary = {
  organizationId: 'org-1' as string | null,
  role: 'owner' as string | null,
  plan: 'enterprise' as 'teams' | 'enterprise',
  isResolving: false,
};

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    organizationId: boundary.organizationId,
    role: boundary.role,
    org:
      boundary.organizationId == null
        ? null
        : {
            id: boundary.organizationId,
            plan: boundary.plan,
            name: 'Acme',
          },
    isResolving: boundary.isResolving,
  }),
}));

vi.mock('@/lib/hooks/use-org-billing-queries', () => ({
  useOrgAuditLogPage: () => ({
    query: pageQuery,
    entries: pageHook.entries,
    hasMore: pageHook.hasMore,
  }),
}));

// `vi.mock` factories are hoisted above this file's imports, so they import
// `createElement` themselves rather than closing over the top-level import.
// The list is a native FlatList in production; here it renders the rows and the
// footer element it was given, so the suite can read and press them.
vi.mock('@shopify/flash-list', async () => {
  const { createElement: h, Fragment: fragment } = await import('react');
  return {
    FlashList: (props: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => unknown;
      ListFooterComponent?: unknown;
    }) =>
      h(
        'FlashList',
        null,
        props.data.map((item, index) =>
          h(fragment, { key: index }, props.renderItem({ item, index }) as never)
        ),
        props.ListFooterComponent as never
      ),
  };
});

vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));

// The settings-row table resolves these at module scope, and the screen reads
// `canViewOrgAuditLog` from it, so every icon it names must exist here.
vi.mock('@/components/ui/icons', () => ({
  Building2: 'Building2',
  Cpu: 'Cpu',
  FileText: 'FileText',
  KeyRound: 'KeyRound',
  LineChart: 'LineChart',
  Lock: 'Lock',
  Mail: 'Mail',
  Plug: 'Plug',
  ScrollText: 'ScrollText',
  Server: 'Server',
  Shield: 'Shield',
  SlidersHorizontal: 'SlidersHorizontal',
  Users: 'Users',
  Wallet: 'Wallet',
}));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/organization/organization-boundary', async () => {
  const { createElement: h } = await import('react');
  return {
    OrganizationBoundary: (props: { title?: string }) => h('OrganizationBoundary', props),
  };
});

vi.mock('@/components/organization/permission-denied', async () => {
  const { createElement: h } = await import('react');
  return {
    PermissionDenied: (props: { description?: string }) => h('PermissionDenied', props),
  };
});

vi.mock('@/components/query-error', async () => {
  const { createElement: h } = await import('react');
  return {
    QueryError: (props: { onRetry?: () => void; isRetrying?: boolean }) => h('QueryError', props),
  };
});

vi.mock('@/components/empty-state', async () => {
  const { createElement: h } = await import('react');
  return {
    EmptyState: (props: { title?: string; description?: string }) => h('EmptyState', props),
  };
});

vi.mock('@/components/screen-header', async () => {
  const { createElement: h } = await import('react');
  return { ScreenHeader: (props: { title?: string }) => h('ScreenHeader', props) };
});

vi.mock('@/components/ui/button', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Button', props, props.children as never),
  };
});

vi.mock('@/components/ui/text', async () => {
  const { createElement: h } = await import('react');
  return {
    Text: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Text', props, props.children as never),
  };
});

vi.mock('react-native', () => ({ View: 'View' }));

function entries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `audit-${index}`,
    action: 'organization.settings.change',
    actor_id: 'user-1',
    actor_email: 'owner@example.com',
    actor_name: 'Owner',
    message: `Audit event ${index}`,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
}

function mount() {
  return renderWithProviders(createElement(OrganizationAuditLogScreen));
}

beforeEach(() => {
  pageQuery.isPending = false;
  pageQuery.isError = false;
  pageQuery.isFetchNextPageError = false;
  pageQuery.isFetching = false;
  pageQuery.isFetchingNextPage = false;
  pageQuery.data = { pages: [], pageParams: [] };
  pageQuery.refetch.mockClear();
  pageQuery.fetchNextPage.mockClear();
  pageHook.entries = [];
  pageHook.hasMore = false;
  boundary.organizationId = 'org-1';
  boundary.role = 'owner';
  boundary.plan = 'enterprise';
  boundary.isResolving = false;
});

type Handler = () => void;

/** The element's callback, narrowed out of the renderer's untyped props. */
function handlerOf(node: ReactTestInstance, name: 'onPress' | 'onRetry'): Handler | undefined {
  const handler: unknown = node.props[name];
  return typeof handler === 'function' ? (handler as Handler) : undefined;
}

describe('OrganizationAuditLogScreen', () => {
  it('refuses a member without the billing role', async () => {
    boundary.role = 'member';
    const { renderer, unmount } = await mount();

    const denied = renderer.root.findAllByType('PermissionDenied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.props.description).toBe(
      'Only an organization owner, admin or billing manager on the Enterprise plan can read its audit log.'
    );
    expect(renderer.root.findAllByType('FlashList')).toHaveLength(0);
    unmount();
  });

  it('refuses an owner of a teams organization', async () => {
    boundary.plan = 'teams';
    const { renderer, unmount } = await mount();

    expect(renderer.root.findAllByType('PermissionDenied')).toHaveLength(1);
    unmount();
  });

  it('holds row skeletons while the first page loads', async () => {
    pageQuery.isPending = true;
    const { renderer, unmount } = await mount();

    expect(renderer.root.findAllByType('Skeleton').length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType('FlashList')).toHaveLength(0);
    unmount();
  });

  it('offers the retry that asks the first page again', async () => {
    pageQuery.isError = true;
    const { renderer, unmount } = await mount();

    const [error] = renderer.root.findAllByType('QueryError');
    expect(error).toBeDefined();
    await act(() => {
      if (error) {
        handlerOf(error, 'onRetry')?.();
      }
    });
    expect(pageQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('shows the empty state when the organization has no events', async () => {
    const { renderer, unmount } = await mount();

    const [empty] = renderer.root.findAllByType('EmptyState');
    expect(empty?.props.title).toBe('No audit events');
    unmount();
  });

  it('renders the entries with their actor and requests the next page', async () => {
    pageHook.entries = entries(3);
    pageHook.hasMore = true;
    const { renderer, unmount } = await mount();

    const messages = renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    for (const index of [0, 1, 2]) {
      expect(messages).toContain(`Audit event ${index}`);
    }

    const loadMore = renderer.root
      .findAllByType('Button')
      .find(node => node.props.accessibilityLabel === 'Load more');
    expect(loadMore).toBeDefined();
    await act(() => {
      if (loadMore) {
        handlerOf(loadMore, 'onPress')?.();
      }
    });
    expect(pageQuery.fetchNextPage).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps the loaded rows when a later page fails, and retries that page', async () => {
    pageHook.entries = entries(2);
    pageHook.hasMore = true;
    pageQuery.isFetchNextPageError = true;
    const { renderer, unmount } = await mount();

    const messages = renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    expect(messages).toContain('Audit event 0');

    const retry = renderer.root
      .findAllByType('Button')
      .find(node => node.props.accessibilityLabel === 'Retry');
    expect(retry).toBeDefined();
    await act(() => {
      if (retry) {
        handlerOf(retry, 'onPress')?.();
      }
    });
    expect(pageQuery.fetchNextPage).toHaveBeenCalledTimes(1);
    unmount();
  });
});
