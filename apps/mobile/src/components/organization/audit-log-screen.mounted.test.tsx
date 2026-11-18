/* eslint-disable max-lines -- cohesive mounted suite for the audit-log screen state contract */

// Audit-log screen state contract: the billing-role/enterprise gate, the first
// page's skeleton, a retryable first-page error, the empty state, the paged list
// with its `hasMore` footer, and a later-page failure that keeps the rows it has.
// A row also names its event through the catalog, falling back to the generic
// event name for an action this build does not know; the created-organization
// row drops its detail line, because the server's message there only restates
// that event name in English.
// A pull refreshes the read in place through the shared `useManualRefresh`.
// One control serves the empty state and the paged list; the first-page error
// branch carries none.
// The query layer is mocked so each state is driven directly through the screen
// JSX, the same way the credit-activity suite does it.

import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { i18n } from '@/i18n';
// The side-effect registration of the i18n module rides on the named import
// above; the screen reaches this adapter through `use-manual-refresh`, and
// importing the mocked module here is how the test reads its spy.
import { announcingToast } from '@/lib/a11y/announcing-toast';
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
            organizationName: 'Acme',
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

// The pull control reaches the reduced-motion policy, which loads expo-battery;
// the list's states are what this suite drives, not the gesture's indicator.
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));

// The failed refresh announces through this adapter, and the real module pulls
// native deps; the spy records the screen's announcement instead.
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: vi.fn() } }));

// `vi.mock` factories are hoisted above this file's imports, so they import
// `createElement` themselves rather than closing over the top-level import.
// The list is a native FlatList in production; here it forwards every prop to
// the host element — the suite reads the list's own `refreshControl` — and it
// renders the rows and the footer element it was given.
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
        props as Record<string, unknown>,
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
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Cpu: 'Cpu',
  FileText: 'FileText',
  KeyRound: 'KeyRound',
  LineChart: 'LineChart',
  Lock: 'Lock',
  Logs: 'Logs',
  Mail: 'Mail',
  Plug: 'Plug',
  ScrollText: 'ScrollText',
  Server: 'Server',
  Shield: 'Shield',
  SlidersHorizontal: 'SlidersHorizontal',
  Users: 'Users',
  UsersRound: 'UsersRound',
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

// The interactive row paints its disclosure chevron with the palette's muted
// ink; the real hook reads the color scheme off `react-native`, which the host
// stub below does not carry.
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#71717a' }),
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));

function entries(count: number, action = 'organization.settings.change', actorEmail?: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `audit-${index}`,
    action,
    actor_id: 'user-1',
    actor_email: actorEmail ?? 'owner@example.com',
    actor_name: 'Owner',
    message: `Audit event ${index}`,
    details: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
}

// The localized detail a guardrails-save row builds from its structured
// details: the sentence comes from the catalog, never from the server's stored
// message, and at real configurations it runs past the two-line clamp.
const LONG_TEMPLATE_DETAIL =
  'Updated AI guardrails: enabled; applies to group Acme; detectors: Prompt injection, PII and secrets (Log only, Secrets), Banned keywords (Log only, 7 keywords), Topics (Log only, 2 topics), Policy violation (3 rules); output guardrails: enabled; output detectors: none';

// The long actor address the truncation case needs: wide enough that the row
// can only hold the whole time when the actor text is the one that shrinks.
const LONG_ACTOR_EMAIL = 'kilokwf1763399999_with_a_really_long_local_part@example.com';

/** The one audit event whose details need the row's disclosure. */
function longEntry() {
  return {
    id: 'audit-long',
    action: 'organization.settings.change',
    actor_id: 'user-1',
    actor_email: 'owner@example.com',
    actor_name: 'Owner',
    message: 'The server never shows this sentence.',
    details: {
      kind: 'guardrails_input' as const,
      enabled: true,
      group: { id: 'g-1', name: 'Acme' },
      detectors: [
        { id: 'injection_attack' as const, enabled: true, action: 'block' as const },
        {
          id: 'pii' as const,
          enabled: true,
          action: 'log' as const,
          entities: ['secrets' as const],
        },
        {
          id: 'keyword_detector' as const,
          enabled: true,
          action: 'log' as const,
          keywordsCount: 7,
        },
        { id: 'topic_detector' as const, enabled: true, action: 'log' as const, topicsCount: 2 },
        { id: 'policy_violation' as const, enabled: true, action: 'block' as const, rulesCount: 3 },
      ],
      outputEnabled: true,
      outputDetectors: [],
    },
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function mount() {
  return renderWithProviders(createElement(OrganizationAuditLogScreen));
}

// The row formats the entry with the device-local clock, so the expected meta
// string is derived through the same formatter instead of a hardcoded
// wall-clock that breaks in a CI timezone east or west of UTC.
const FIXED_INSTANT = new Date('2026-01-01T00:00:00.000Z');
function expectedMetaTime(locale: string): string {
  const day = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(FIXED_INSTANT);
  const clock = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(FIXED_INSTANT);
  return `${day} · ${clock}`;
}

beforeEach(() => {
  pageQuery.isPending = false;
  pageQuery.isError = false;
  pageQuery.isFetchNextPageError = false;
  pageQuery.isFetching = false;
  pageQuery.isFetchingNextPage = false;
  pageQuery.data = { pages: [], pageParams: [] };
  pageQuery.refetch.mockClear();
  // The pull reads the settled result, so the spy resolves one by default.
  pageQuery.refetch.mockResolvedValue({ isError: false });
  pageQuery.fetchNextPage.mockClear();
  pageHook.entries = [];
  pageHook.hasMore = false;
  boundary.organizationId = 'org-1';
  boundary.role = 'owner';
  boundary.plan = 'enterprise';
  boundary.isResolving = false;
});

type Handler = () => void;

/** Props a pull-to-refresh control carries. */
type PullControl = ReactElement<{ refreshing: boolean; onRefresh: () => void }>;

/** The pull gesture a pull-to-refresh surface carries; a missing one fails the test. */
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

/** The row's detail line, found by its opening words in either state. */
function messageLine(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Text')
    .find(
      node =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Updated AI guardrails')
    );
}

/** The row's disclosure state; the renderer's props carry no type. */
function disclosureState(node: ReactTestInstance): boolean | undefined {
  const state = node.props.accessibilityState as { expanded?: boolean } | undefined;
  return state?.expanded;
}

/** Presses the row's disclosure and lets the re-render settle. */
async function pressDisclosure(renderer: ReactTestRenderer): Promise<void> {
  const [row] = renderer.root.findAllByType('Pressable');
  if (!row) {
    throw new Error('audit row disclosure not found');
  }
  await act(() => {
    handlerOf(row, 'onPress')?.();
  });
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

  it('names the event, shows the actor, and requests the next page', async () => {
    pageHook.entries = entries(3);
    pageHook.hasMore = true;
    const { renderer, unmount } = await mount();

    const messages = renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    // A row without structured details shows the localized event name, actor,
    // and time — never the stored English server sentence.
    for (const index of [0, 1, 2]) {
      expect(messages).not.toContain(`Audit event ${index}`);
    }
    // The row names the event in the reader's language, never the wire action.
    expect(messages).toContain('Settings changed');
    expect(messages.some(text => text.includes('organization.settings.change'))).toBe(false);
    // The actor and the time are separate texts now; the actor comes first.
    expect(messages).toContain('owner@example.com');
    expect(messages.some(text => text.startsWith(expectedMetaTime('en')))).toBe(true);

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

  it('lets the actor truncate in its own text and keeps the whole time', async () => {
    // The wire address an actual long actor email fills the row with: the time
    // must survive it, because the time is what tells the entries apart.
    pageHook.entries = entries(1, 'organization.settings.change', LONG_ACTOR_EMAIL);
    const { renderer, unmount } = await mount();

    const texts = renderer.root.findAllByType('Text');
    const actorText = texts.find(node => node.props.children === LONG_ACTOR_EMAIL);
    const expectedTime = expectedMetaTime('en');
    const timeText = texts.find(
      node => typeof node.props.children === 'string' && node.props.children === expectedTime
    );
    expect(actorText).toBeDefined();
    expect(timeText).toBeDefined();
    // RN defaults flexShrink to 0; the actor must opt in to shrinking, or the
    // long address paints the time off the row's end instead of truncating.
    expect(actorText?.props.className).toContain('min-w-0');
    expect(actorText?.props.className).toContain('shrink');
    expect(actorText?.props.className).not.toContain('shrink-0');
    expect(actorText?.props.numberOfLines).toBe(1);
    // The time never yields its width, so the whole reading stays on screen
    // whatever the actor does.
    expect(timeText?.props.className).toContain('shrink-0');
    expect(timeText?.props.children).toBe(expectedTime);
    unmount();
  });

  it('reads the Arabic time in its own order next to the left-to-right email', async () => {
    pageHook.entries = entries(1, 'organization.settings.change');
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    try {
      const { renderer, unmount } = await mount();

      const texts = renderer.root.findAllByType('Text');
      const actorText = texts.find(node => node.props.children === 'owner@example.com');
      // The meta time is the row's only text that keeps the catalog's ` · `
      // separator shape.
      const timeText = texts.find(
        node => typeof node.props.children === 'string' && node.props.children.includes(' · ')
      );
      expect(actorText).toBeDefined();
      expect(timeText).toBeDefined();
      // The date carries the Arabic month in its own element, so its parts
      // keep the language's reading order instead of running inside the email
      // line's direction; the email stays beside it as plain Latin text.
      expect(timeText?.props.children).toBe(expectedMetaTime('ar'));
      expect(actorText?.props.children).toBe('owner@example.com');
      // The reader hears actor and time in one sentence, with the date parts
      // in the order the catalog writes them.
      const pressable = renderer.root.findByType('Pressable');
      expect(pressable.props.accessibilityLabel).toContain('owner@example.com, ');
      unmount();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('omits the restating server message on the created organization row', async () => {
    pageHook.entries = [
      {
        id: 'audit-created',
        action: 'organization.created',
        actor_id: 'user-1',
        actor_email: 'owner@example.com',
        actor_name: 'Owner',
        message: 'Organization Acme created',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const { renderer, unmount } = await mount();

    const texts = renderer.root.findAllByType('Text');
    const messages = texts
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    expect(messages).toContain('Organization created');
    // The actor and the time are separate texts; the actor comes first.
    expect(messages).toContain('owner@example.com');
    expect(messages.some(text => text.startsWith(expectedMetaTime('en')))).toBe(true);
    // The row keeps the translated event name and drops the server sentence,
    // which only restates that name and would age into a stale one.
    expect(messages).not.toContain('Organization Acme created');
    expect(texts.some(node => node.props.numberOfLines === 2)).toBe(false);
    expect(messages.some(text => text.includes('organization.created'))).toBe(false);
    // Nothing to disclose, so the row is a plain view rather than a pressable.
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    unmount();
  });

  it('clamps a long message to two lines and reveals it on one press', async () => {
    pageHook.entries = [longEntry()];
    const { renderer, unmount } = await mount();

    expect(LONG_TEMPLATE_DETAIL.length).toBeGreaterThan(200);
    // The node holds the whole sentence even while the layout clips it: the
    // bound is a layout prop, not a truncation of the copy.
    expect(messageLine(renderer)?.props.children).toBe(LONG_TEMPLATE_DETAIL);
    expect(messageLine(renderer)?.props.numberOfLines).toBe(2);

    await pressDisclosure(renderer);
    // The same text node stays; the press drops the bound rather than swapping
    // in a second, fuller copy.
    expect(messageLine(renderer)?.props.children).toBe(LONG_TEMPLATE_DETAIL);
    expect(messageLine(renderer)?.props.numberOfLines).not.toBe(2);

    await pressDisclosure(renderer);
    expect(messageLine(renderer)?.props.numberOfLines).toBe(2);
    unmount();
  });

  it('reports the disclosure and the whole message to assistive technology', async () => {
    pageHook.entries = [longEntry()];
    const { renderer, unmount } = await mount();

    const pressables = renderer.root.findAllByType('Pressable');
    expect(pressables.filter(node => disclosureState(node) === false)).toHaveLength(1);
    const closed = pressables.find(node => disclosureState(node) === false);
    expect(closed?.props.accessibilityRole).toBe('button');
    // The clamp is visual only: a reader reaches the whole sentence unopened.
    expect(closed?.props.accessibilityLabel).toContain(LONG_TEMPLATE_DETAIL);

    await pressDisclosure(renderer);
    const open = renderer.root
      .findAllByType('Pressable')
      .find(node => disclosureState(node) === true);
    expect(open).toBeDefined();
    expect(open?.props.accessibilityRole).toBe('button');
    expect(open?.props.accessibilityLabel).toContain(LONG_TEMPLATE_DETAIL);
    unmount();
  });

  it('names an action it has no label for with the generic event name', async () => {
    pageHook.entries = entries(1, 'organization.future.action');
    const { renderer, unmount } = await mount();

    const messages = renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    expect(messages).toContain('Audit event');
    // The generic event name replaces both the wire identifier and the server
    // sentence a reader cannot parse.
    expect(messages).not.toContain('Audit event 0');
    expect(messages.some(text => text.includes('organization.future.action'))).toBe(false);
    unmount();
  });

  it('shows no detail line for a row without structured details, and never the raw server message', async () => {
    pageHook.entries = [
      {
        id: 'audit-prose',
        action: 'organization.member.change_role',
        actor_id: 'user-1',
        actor_email: 'owner@example.com',
        actor_name: 'Owner',
        message: 'Changed role for ada@example.com from member to admin',
        details: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const { renderer, unmount } = await mount();

    const messages = renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    expect(messages).toContain('Member role changed');
    // The English server sentence stays server-facing: an old row or a prose-only writer
    // renders the event name, actor, and time only.
    expect(messages).not.toContain('Changed role for ada@example.com from member to admin');
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    unmount();
  });

  it('builds the detail line from the row details, not the stored message', async () => {
    pageHook.entries = [longEntry()];
    const { renderer, unmount } = await mount();

    const messages = renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    expect(messages).toContain(LONG_TEMPLATE_DETAIL);
    expect(messages).not.toContain('The server never shows this sentence.');
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
    expect(messages).toContain('Settings changed');

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

describe('OrganizationAuditLogScreen pull to refresh', () => {
  it('puts the pull on the empty state and refetches from it', async () => {
    // The read settled with no rows, so the empty state is the only surface to
    // pull; the refetch spy resolves the settled result beforeEach set up.
    const { renderer, unmount } = await mount();

    const [empty] = renderer.root.findAllByType('EmptyState');
    if (!empty) {
      throw new Error('the empty state did not render');
    }
    const control = pullControl(empty);
    expect(control.type).toBe('RefreshControl');
    expect(control.props.refreshing).toBe(false);
    // The gesture is not in flight, so nothing spins until the pull starts.
    expect(pageQuery.refetch).not.toHaveBeenCalled();

    await act(async () => {
      control.props.onRefresh();
      await Promise.resolve();
    });
    expect(pageQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('hands the same control to the list when rows are present', async () => {
    pageHook.entries = entries(2);
    pageHook.hasMore = true;
    const { renderer, unmount } = await mount();

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
    expect(pageQuery.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps the rows and announces the failure when the pull fails', async () => {
    // The settled result keeps the rows on screen; only the refetch's own
    // verdict fails, so the pull announces instead of replacing the list.
    pageHook.entries = entries(2);
    pageHook.hasMore = true;
    pageQuery.isError = false;
    pageQuery.refetch.mockResolvedValue({ isError: true });
    const { renderer, unmount } = await mount();

    const [list] = renderer.root.findAllByType('FlashList');
    if (!list) {
      throw new Error('the rows were not handed to the list');
    }
    expect(renderer.root.findAllByType('QueryError')).toHaveLength(0);
    const control = pullControl(list);
    await act(async () => {
      control.props.onRefresh();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByType('FlashList')).toHaveLength(1);
    expect(renderer.root.findAllByType('QueryError')).toHaveLength(0);
    expect(announcingToast.error).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('offers no pull while the first page has failed', async () => {
    // The list never painted, so the branch renders the retry alone; the
    // gesture element must not exist anywhere in the tree.
    pageQuery.isError = true;
    pageQuery.data = { pages: [], pageParams: [] };
    const { renderer, unmount } = await mount();

    expect(renderer.root.findAllByType('QueryError')).toHaveLength(1);
    expect(renderer.root.findAllByType('RefreshControl')).toHaveLength(0);
    unmount();
  });
});
