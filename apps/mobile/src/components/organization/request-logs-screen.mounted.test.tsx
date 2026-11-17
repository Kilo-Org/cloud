/* eslint-disable max-lines -- one mounted suite covers the screen's gate, its four body states, the window stepper and the row fields */

// Request-logs screen state contract: the billing-role gate, the skeleton while a
// window loads, a retryable failure that offers the retry, a refusal that offers
// none, the empty state, the row's fields, the truncation notice, and the window
// stepper that is both the time range and the paging. The query layer is mocked
// so each state is driven directly through the screen JSX, the same way the
// audit-log suite does it.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { i18n } from '@/i18n';
import { OrganizationRequestLogsScreen } from './request-logs-screen';

const HOUR_MS = 60 * 60 * 1000;

const logsQuery = vi.hoisted(() => ({
  startTimes: [] as string[],
  enabled: [] as boolean[],
  data: undefined as unknown,
  error: null as unknown,
  isFetching: false,
  refetch: vi.fn(),
}));

const boundary = {
  organizationId: 'org-1' as string | null,
  role: 'owner' as string | null,
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
            plan: 'teams',
            organizationName: 'Acme',
          },
    isResolving: boundary.isResolving,
  }),
}));

vi.mock('@/lib/hooks/use-org-billing-queries', () => ({
  useOrgRequestLogs: (
    _organizationId: string | null,
    startTime: string,
    enabled: boolean
  ) => {
    logsQuery.startTimes.push(startTime);
    logsQuery.enabled.push(enabled);
    return {
      data: logsQuery.data,
      error: logsQuery.error,
      isPending: false,
      isFetching: logsQuery.isFetching,
      refetch: logsQuery.refetch,
    };
  },
}));

// `vi.mock` factories are hoisted above this file's imports, so they import
// `createElement` themselves rather than closing over the top-level import.
// The list is a native list in production; here it renders the rows and the
// footer element it was given, so the suite can read them.
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

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: 'black' }),
}));

vi.mock('@/components/ui/icons', () => ({ FileText: 'FileText' }));

vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronLeft: 'DirectionalChevronLeft',
  DirectionalChevronRight: 'DirectionalChevronRight',
}));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));

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
    QueryError: (props: { onRetry?: () => void; isRetrying?: boolean; variant?: string }) =>
      h('QueryError', props),
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
    id: `log-${index}`,
    created_at: '2026-01-01T10:00:00.000Z',
    user: { id: 'user-1', name: 'Owner', email: 'owner@example.com' },
    model: 'anthropic/claude-sonnet-4',
    provider: 'Anthropic',
    user_agent_name: 'Kilo Code',
    cost_microdollars: 1_000_000,
    input_tokens: 1234,
    output_tokens: 567,
    cache_hit_tokens: 0,
    is_user_byok: index === 0,
    has_error: false,
    project_id: null,
    feature: null,
    latency_ms: null,
    generation_time_ms: null,
  }));
}

function mount() {
  return renderWithProviders(createElement(OrganizationRequestLogsScreen));
}

type Handler = () => void;

/** The element's callback, narrowed out of the renderer's untyped props. */
function handlerOf(node: ReactTestInstance, name: 'onPress' | 'onRetry'): Handler | undefined {
  const handler: unknown = node.props[name];
  return typeof handler === 'function' ? (handler as Handler) : undefined;
}

function texts(renderer: { root: ReactTestInstance }): string[] {
  return renderer.root
    .findAllByType('Text')
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

beforeEach(() => {
  logsQuery.startTimes = [];
  logsQuery.enabled = [];
  logsQuery.data = undefined;
  logsQuery.error = null;
  logsQuery.isFetching = false;
  logsQuery.refetch.mockClear();
  boundary.organizationId = 'org-1';
  boundary.role = 'owner';
  boundary.isResolving = false;
});

describe('OrganizationRequestLogsScreen', () => {
  it('refuses a member without the billing role', async () => {
    boundary.role = 'member';
    const { renderer, unmount } = await mount();

    const [denied] = renderer.root.findAllByType('PermissionDenied');
    expect(denied?.props.description).toBe(
      'Only an organization owner, admin or billing manager can read its request logs.'
    );
    // The gate is also what the query reads: a member never asks the server.
    expect(logsQuery.enabled.at(-1)).toBe(false);
    expect(renderer.root.findAllByType('FlashList')).toHaveLength(0);
    unmount();
  });

  it('holds row skeletons while the window loads', async () => {
    const { renderer, unmount } = await mount();

    expect(renderer.root.findAllByType('Skeleton').length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType('FlashList')).toHaveLength(0);
    unmount();
  });

  it('offers the retry a transient failure can use', async () => {
    logsQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' } };
    const { renderer, unmount } = await mount();

    const [error] = renderer.root.findAllByType('QueryError');
    expect(error?.props.variant).toBe('server');
    await act(() => {
      if (error) {
        handlerOf(error, 'onRetry')?.();
      }
    });
    expect(logsQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('names a refusal and offers no retry', async () => {
    logsQuery.error = { data: { code: 'FORBIDDEN', message: 'not allowed' } };
    const { renderer, unmount } = await mount();

    const [error] = renderer.root.findAllByType('QueryError');
    expect(error?.props.variant).toBe('permission');
    // Asking again returns the same verdict, so the state has no action.
    expect(error?.props.onRetry).toBeUndefined();
    unmount();
  });

  it('shows the empty state when the hour has no requests', async () => {
    logsQuery.data = [];
    const { renderer, unmount } = await mount();

    const [empty] = renderer.root.findAllByType('EmptyState');
    expect(empty?.props.title).toBe('No requests');
    expect(empty?.props.description).toBe('This hour has no gateway requests.');
    unmount();
  });

  it('prints every field the web table shows, and the BYOK marker', async () => {
    logsQuery.data = entries(1);
    const { renderer, unmount } = await mount();

    const painted = texts(renderer);
    expect(painted).toContain('anthropic/claude-sonnet-4');
    expect(painted).toContain('Owner');
    expect(painted).toContain('Anthropic');
    expect(painted).toContain('$1.00');
    expect(painted.some(text => text.includes('1,234 in'))).toBe(true);
    expect(painted.some(text => text.includes('567 out'))).toBe(true);
    expect(painted).toContain('BYOK');
    unmount();
  });

  it('marks a window whose rows hit the server cap as truncated', async () => {
    logsQuery.data = entries(100);
    const { renderer, unmount } = await mount();

    expect(texts(renderer)).toContain('This hour has more requests than the list shows.');
    unmount();
  });

  it('steps a window at a time, and never forward past the current hour', async () => {
    logsQuery.data = entries(1);
    const { renderer, unmount } = await mount();

    const buttons = renderer.root.findAllByType('Button');
    const older = buttons.find(node => node.props.accessibilityLabel === 'Older hour');
    const newer = buttons.find(node => node.props.accessibilityLabel === 'Newer hour');
    expect(older).toBeDefined();
    // Nothing newer than now exists, so the trailing step starts disabled.
    expect(newer?.props.disabled).toBe(true);

    const anchor = Date.parse(logsQuery.startTimes.at(-1) ?? '');
    await act(() => {
      if (older) {
        handlerOf(older, 'onPress')?.();
      }
    });
    const previous = Date.parse(logsQuery.startTimes.at(-1) ?? '');
    expect(anchor - previous).toBe(HOUR_MS);
    // The header names the window the rows belong to.
    expect(texts(renderer).some(text => text.includes('–'))).toBe(true);

    const stepBack = renderer.root
      .findAllByType('Button')
      .find(node => node.props.accessibilityLabel === 'Newer hour');
    await act(() => {
      if (stepBack) {
        handlerOf(stepBack, 'onPress')?.();
      }
    });
    expect(Date.parse(logsQuery.startTimes.at(-1) ?? '')).toBe(anchor);
    unmount();
  });

  it('holds the boundary until the organization resolves', async () => {
    boundary.isResolving = true;
    const { renderer, unmount } = await mount();

    expect(renderer.root.findAllByType('OrganizationBoundary')).toHaveLength(1);
    unmount();
  });

  it('titles the screen with the row that opened it', async () => {
    const { renderer, unmount } = await mount();

    const [header] = renderer.root.findAllByType('ScreenHeader');
    expect(header?.props.title).toBe(i18n.t('organization.settingsOnWeb.requestLogs'));
    unmount();
  });
});
