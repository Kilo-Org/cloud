/* eslint-disable max-lines -- one mounted suite covers the screen's gate, its four body states, the window stepper and the row fields */

// Request-logs screen state contract: the billing-role gate, the skeleton while a
// window loads, one failure body whose copy and retry come from the shared
// failure classifier, the empty state, the row's fields, the truncation notice,
// the window stepper that is both the time range and the paging, and a pull that
// refetches the read in place and announces its failure. The query layer is
// mocked so each state is driven directly through the screen JSX, the same way
// the audit-log suite does it.

import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { i18n } from '@/i18n';
// The side-effect registration of the i18n module rides on the named import
// above; the screen reaches this adapter through `use-manual-refresh`, and
// importing the mocked module here is how the test reads its spy.
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { canStepOlderTo, HISTORY_DAYS } from './request-log-window';
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
  useOrgRequestLogs: (_organizationId: string | null, startTime: string, enabled: boolean) => {
    logsQuery.startTimes.push(startTime);
    logsQuery.enabled.push(enabled);
    return {
      data: logsQuery.data,
      error: logsQuery.error,
      isFetching: logsQuery.isFetching,
      refetch: logsQuery.refetch,
    };
  },
}));

// `vi.mock` factories are hoisted above this file's imports, so they import
// `createElement` themselves rather than closing over the top-level import.
// The list is a native list in production; here it renders the rows and the
// footer element it was given, and forwards its own props (the pull control
// among them) onto the host node, so the suite reads them from there.
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
        props,
        props.data.map((item, index) =>
          h(fragment, { key: index }, props.renderItem({ item, index }) as never)
        ),
        props.ListFooterComponent as never
      ),
  };
});

// The screen's empty and failure bodies ride in `TabScreenScrollView`, so a
// pull handed to a `placement="top"` state (which renders no scroller and drops
// the prop) would never reach the gesture. The stub forwards every prop onto a
// host node, so the suite reads the control from the scroller the screen
// actually renders.
vi.mock('@/components/tab-screen', async () => {
  const { createElement: h } = await import('react');
  return {
    useTabBarBottomPadding: () => 0,
    TabScreenScrollView: (props: { children?: unknown }) => h('TabScreenScrollView', props),
  };
});

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: 'black' }),
  useMutedDisabledInk: () => '#999999',
}));

vi.mock('@/components/ui/icons', () => ({ Logs: 'Logs' }));

vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalArrowLeft: 'DirectionalArrowLeft',
  DirectionalArrowRight: 'DirectionalArrowRight',
  DirectionalChevronLeft: 'DirectionalChevronLeft',
  DirectionalChevronRight: 'DirectionalChevronRight',
  DirectionalLogs: 'DirectionalLogs',
}));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));

// The failed pull announces through this adapter, and the real module pulls
// native deps; the spy records the screen's announcement instead.
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: vi.fn() } }));

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
    StateAction: 'StateAction',
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

/** Props a pull-to-refresh control carries. */
type PullControl = ReactElement<{ refreshing: boolean; onRefresh: () => void }>;

/**
 * The pull gesture a pull-to-refresh surface carries; a missing one fails the
 * test. The control is a host stub here (`'RefreshControl'`), so it is read
 * from the host's props rather than found by type.
 */
function pullControl(host: ReactTestInstance): PullControl {
  const control = host.props.refreshControl as PullControl | undefined;
  if (!control) {
    throw new Error(`${String(host.type)} rendered no pull control`);
  }
  return control;
}

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
  // The pull reads the settled result, so the spy resolves one by default.
  logsQuery.refetch.mockResolvedValue({ isError: false });
  vi.mocked(announcingToast.error).mockClear();
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

  it('names the connection for a failure that never reached the server', async () => {
    // The read settles instead of pausing, so an offline cold start fails with
    // the transport rejection rather than a paused read.
    logsQuery.error = new TypeError('Network request failed');
    const { renderer, unmount } = await mount();

    const [error] = renderer.root.findAllByType('QueryError');
    expect(error?.props.variant).toBe('offline');
    // The failure replaced the skeleton, which is the point of settling.
    expect(renderer.root.findAllByType('Skeleton')).toHaveLength(0);
    await act(() => {
      if (error) {
        handlerOf(error, 'onRetry')?.();
      }
    });
    expect(logsQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('offers the retry a server failure can use', async () => {
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

  it('names a removed window as not-found and offers no retry', async () => {
    logsQuery.error = { data: { code: 'NOT_FOUND', message: 'no such organization' } };
    const { renderer, unmount } = await mount();

    const [error] = renderer.root.findAllByType('QueryError');
    expect(error?.props.variant).toBe('not-found');
    expect(error?.props.onRetry).toBeUndefined();
    unmount();
  });

  it('keeps its own copy for a terminal failure that no retry can fix', async () => {
    // The procedure rejects a start time outside its own bound with a bad
    // request, and the device clock supplies that time, so this branch is
    // reachable from the screen. Its state withholds the retry, so the copy
    // must not promise one.
    logsQuery.error = { data: { code: 'BAD_REQUEST', message: 'Start time must be recent' } };
    const { renderer, unmount } = await mount();

    const [error] = renderer.root.findAllByType('QueryError');
    expect(error?.props.variant).toBe('server');
    expect(error?.props.message).toBe("Couldn't load request logs.");
    expect(error?.props.onRetry).toBeUndefined();
    unmount();
  });

  it('shows the empty state when the hour has no requests', async () => {
    logsQuery.data = [];
    const { renderer, unmount } = await mount();

    const [empty] = renderer.root.findAllByType('EmptyState');
    expect(empty?.props.title).toBe('No requests in this hour');
    // The window header names the hour; the description points at the paging
    // control, so it is here while an older hour still exists.
    expect(empty?.props.description).toBe('Use Older hour to see earlier requests.');
    unmount();
  });

  it('drops the Older-hour pointer once the history bound stops the step', async () => {
    logsQuery.data = [];
    const { renderer, unmount } = await mount();

    const buttons = renderer.root.findAllByType('Button');
    const older = buttons.find(node => node.props.accessibilityLabel === 'Older hour');
    expect(older).toBeDefined();
    // Drive the window to the bound one step at a time: the oldest reachable
    // window end is one hour inside the age bound, so the loop needs the
    // full history of hours. Each act flushes one batch of updates through
    // React's scheduler.
    const BATCH = 1000;
    const maxSteps = HISTORY_DAYS * 24;
    for (let steps = 0; steps < maxSteps; steps += BATCH) {
      if (older?.props.disabled) {
        break;
      }
      for (let step = 0; step < BATCH && steps + step < maxSteps; step += 1) {
        if (older?.props.disabled) {
          break;
        }
        act(() => {
          if (older) {
            handlerOf(older, 'onPress')?.();
          }
        });
      }
    }
    expect(older?.props.disabled).toBe(true);

    const [empty] = renderer.root.findAllByType('EmptyState');
    expect(empty?.props.title).toBe('No requests in this hour');
    // A pointer at a disabled control would be a dead end; at the bound the
    // state names the bound instead, so the reader knows why Older hour is off.
    expect(empty?.props.description).toBe('This is as far back as request logs go.');
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
    // One row line carries the time and the token pair, so the catalog's own
    // ` · ` spaces both dots. The time is a first-strong isolate, so its AM/PM
    // marker stays beside the clock in either direction.
    const meta = painted.find(text => text.includes('1,234 in') && text.includes('·'));
    expect(meta).toBeDefined();
    expect(meta?.startsWith('\u2068')).toBe(true);
    expect(meta).toContain('\u2069 · ');
    expect(meta?.split('·')).toHaveLength(3);
    expect(painted).toContain('BYOK');
    unmount();
  });

  it('marks a window whose rows hit the server cap as truncated', async () => {
    logsQuery.data = entries(100);
    const { renderer, unmount } = await mount();

    expect(texts(renderer)).toContain('This hour has more requests than the list shows.');
    unmount();
  });

  it('stops the stepper inside the oldest start time the server accepts', () => {
    const anchor = Date.parse('2026-11-17T12:00:00.000Z');
    const maxAgeMs = 365 * 24 * HOUR_MS;
    // The procedure measures the window end against its own clock, which runs
    // later than the mount-time anchor, so the exact 365-day edge is refused
    // and the step one hour inside it is the oldest one offered.
    expect(canStepOlderTo(anchor - maxAgeMs, anchor)).toBe(false);
    expect(canStepOlderTo(anchor - maxAgeMs + HOUR_MS, anchor)).toBe(true);
    expect(canStepOlderTo(anchor, anchor)).toBe(true);
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
    // The header names the window the rows belong to. Each clock is a
    // first-strong isolate, so the AM/PM marker stays beside its own clock and
    // the catalog's join keeps the pair in the language's order.
    const range = texts(renderer).find(text => text.includes('–'));
    expect(range).toBeDefined();
    expect(range?.split('\u2068')).toHaveLength(3);
    expect(range).not.toContain('\u2066');

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

describe('OrganizationRequestLogsScreen pull to refresh', () => {
  // The pull is read from the scroller the screen actually renders, never from
  // the state inside it: a `placement="top"` state renders no scroller and
  // drops a `refreshControl`, so a pull handed to one would leave the gesture
  // with nowhere to land while the suite still passed.
  it('puts the pull on the scroller over the empty hour and refetches from it', async () => {
    // The hour settled with no rows, so this scroller carries the only pull.
    logsQuery.data = [];
    const { renderer, unmount } = await mount();

    const [scroller] = renderer.root.findAllByType('TabScreenScrollView');
    if (!scroller) {
      throw new Error('the empty hour rendered no scroller');
    }
    const control = pullControl(scroller);
    expect(control.type).toBe('RefreshControl');
    expect(control.props.refreshing).toBe(false);
    expect(logsQuery.refetch).not.toHaveBeenCalled();

    await act(async () => {
      control.props.onRefresh();
      await Promise.resolve();
    });
    expect(logsQuery.refetch).toHaveBeenCalledTimes(1);
    // The pull succeeded, so nothing is announced.
    expect(announcingToast.error).not.toHaveBeenCalled();
    unmount();
  });

  it('puts the pull on the scroller over the failure body and refetches from it', async () => {
    // A failure that never left the device: the body is the only surface, so a
    // reader with no connection must still be able to pull the read again.
    logsQuery.error = new TypeError('Network request failed');
    const { renderer, unmount } = await mount();

    const [scroller] = renderer.root.findAllByType('TabScreenScrollView');
    if (!scroller) {
      throw new Error('the failure body rendered no scroller');
    }
    const control = pullControl(scroller);
    expect(control.type).toBe('RefreshControl');
    expect(logsQuery.refetch).not.toHaveBeenCalled();

    await act(async () => {
      control.props.onRefresh();
      await Promise.resolve();
    });
    expect(logsQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('announces a failed pull once and keeps the empty copy on screen', async () => {
    // The read already settled empty; only the pull's own verdict fails, so the
    // screen announces it instead of replacing what is on screen.
    logsQuery.data = [];
    logsQuery.refetch.mockResolvedValue({ isError: true });
    const { renderer, unmount } = await mount();

    const [scroller] = renderer.root.findAllByType('TabScreenScrollView');
    if (!scroller) {
      throw new Error('the empty hour rendered no scroller');
    }

    await act(async () => {
      pullControl(scroller).props.onRefresh();
      await Promise.resolve();
    });

    expect(announcingToast.error).toHaveBeenCalledTimes(1);
    expect(announcingToast.error).toHaveBeenCalledWith(i18n.t('common.couldNotRefresh'));
    const [stillEmpty] = renderer.root.findAllByType('EmptyState');
    expect(stillEmpty?.props.title).toBe('No requests in this hour');
    unmount();
  });

  it('keeps the list branch on its own pull, not in the state scroller', async () => {
    logsQuery.data = entries(2);
    const { renderer, unmount } = await mount();

    // The rows are a virtualized list, so its own pull is the only one; nesting
    // it in the state scroller would break the list's recycling.
    expect(renderer.root.findAllByType('TabScreenScrollView')).toHaveLength(0);
    const [list] = renderer.root.findAllByType('FlashList');
    if (!list) {
      throw new Error('the rows were not handed to the list');
    }
    const control = pullControl(list);
    expect(control.type).toBe('RefreshControl');

    await act(async () => {
      control.props.onRefresh();
      await Promise.resolve();
    });
    expect(logsQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });
});
