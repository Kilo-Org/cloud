/* eslint-disable max-lines -- cohesive mounted suite for the audit-log screen state contract */

// Audit-log screen state contract: the billing-role/enterprise gate, the first
// page's skeleton, a retryable first-page error, the empty state, the paged list
// with its `hasMore` footer, and a later-page failure that keeps the rows it has.
// A row also names its event through the catalog, falling back to the generic
// event name for an action this build does not know. Its detail line is built
// from the structured `details` payload in the reader's language, never from
// the server's English `message`; a row with no payload at all shows its event
// name alone and offers nothing to disclose.
// A pull refreshes the read in place through the shared `useManualRefresh`.
// One control serves the empty state and the paged list; the first-page error
// branch carries none.
// The query layer is mocked so each state is driven directly through the screen
// JSX, the same way the credit-activity suite does it.

import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditDetail } from '@kilocode/app-shared/organizations';

import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { i18n } from '@/i18n';
// The side-effect registration of the i18n module rides on the named import
// above; the screen reaches this adapter through `use-manual-refresh`, and
// importing the mocked module here is how the test reads its spy.
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { auditEntryDetail } from './audit-log-detail';
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

// The static band reserves its own row above the scroller under reduced motion;
// this suite asserts where it sits and which control it carries, not its paint.
vi.mock('@/components/ui/refresh-progress', () => ({ RefreshProgress: 'RefreshProgress' }));

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

// The interactive row paints its disclosure chevron with the palette's muted
// ink; the real hook reads the color scheme off `react-native`, which the host
// stub below does not carry.
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#71717a' }),
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));

const t = i18n.t.bind(i18n);

/**
 * The detail line the row renders, derived through the same renderer the screen
 * calls and in the language the suite is reading. An assertion therefore states
 * the contract — this payload, this language — instead of pinning one catalog
 * sentence, which any wording change would break.
 */
function detailFor(details: AuditDetail): string {
  const line = auditEntryDetail(t, i18n.language, details);
  if (line === undefined) {
    throw new Error(`${details.id} rendered no detail line`);
  }
  return line;
}

/** The structured payload `entries()` stores, so an assertion derives its line. */
function entryDetail(index: number): AuditDetail {
  return { id: 'setting.name', previous: `Acme ${index}`, next: `Acme ${index + 1}` };
}

function entries(count: number, action = 'organization.settings.change', actorEmail?: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `audit-${index}`,
    action,
    actor_id: 'user-1',
    actor_email: actorEmail ?? 'owner@example.com',
    actor_name: 'Owner',
    // The row renders this payload; `message` stays the server's English
    // sentence, which the screen must never show.
    details: entryDetail(index),
    message: `Audit event ${index}`,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
}

// The long actor address the truncation case needs: wide enough that the row
// can only hold the whole time when the actor text is the one that shrinks.
const LONG_ACTOR_EMAIL = 'kilokwf1763399999_with_a_really_long_local_part@example.com';

/**
 * A detail line that runs well past the clamped two lines: an automatic
 * re-routing save that names a whole pool of models, long enough that the
 * collapsed row must clip it.
 */
const LONG_DETAIL = {
  id: 'autoRouting.models',
  added: [
    {
      provider: 'anthropic',
      models: [
        'claude-sonnet-4-5',
        'claude-opus-4-1',
        'claude-haiku-4-5',
        'claude-3-7-sonnet',
        'claude-3-5-haiku',
      ],
    },
    {
      provider: 'openai',
      models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'codex-mini-latest', 'o4-mini'],
    },
  ],
  removed: ['gemini-2.5-pro', 'gemini-2.5-flash', 'grok-4'],
} satisfies AuditDetail;

// The server's English sentence for the same event. It is long as well, so a
// row that fell back to it would pass a clamp check by accident; the suite
// asserts it never reaches the screen at all.
const SERVER_MESSAGE =
  'ada@example.com was made a billing manager for the quarterly close; the invite that followed adds them to the seats purchase that renews next month, and the invoice for those seats now bills the organization instead of the personal account it started on';

/** The one audit event whose detail line needs the row's disclosure. */
function longEntry() {
  return {
    id: 'audit-long',
    action: 'organization.settings.auto_change',
    actor_id: 'user-1',
    actor_email: 'owner@example.com',
    actor_name: 'Owner',
    details: LONG_DETAIL,
    message: SERVER_MESSAGE,
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

/** The row's detail line, found by the exact string the fixture payload renders. */
function detailLine(renderer: ReactTestRenderer, details: AuditDetail) {
  const expected = detailFor(details);
  return renderer.root
    .findAllByType('Text')
    .find(node => typeof node.props.children === 'string' && node.props.children === expected);
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
    // The refusal's copy lives in the catalog; this pins that the state reads
    // this screen's own key, so a member sees the roles and the next step.
    expect(denied[0]?.props.description).toBe(i18n.t('organization.auditLog.permissionDenied'));
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

  it('names the event, shows the detail, and requests the next page', async () => {
    pageHook.entries = entries(3);
    pageHook.hasMore = true;
    const { renderer, unmount } = await mount();

    const messages = renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    // Each row renders its own structured detail, never the server's sentence.
    for (const index of [0, 1, 2]) {
      expect(messages).toContain(detailFor(entryDetail(index)));
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
    // which would age into a stale English copy of that name.
    expect(messages).not.toContain('Organization Acme created');
    expect(texts.some(node => node.props.numberOfLines === 2)).toBe(false);
    expect(messages.some(text => text.includes('organization.created'))).toBe(false);
    // No structured event, so nothing to disclose and the row is a plain view.
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    unmount();
  });

  it('shows the event name alone for a row written before the details column', async () => {
    // A row the server wrote before it stored a structured event: `details` is
    // absent, and the English `message` is the only other text it carries. The
    // row must show neither a detail line nor that message.
    pageHook.entries = [
      {
        id: 'audit-historical',
        action: 'organization.settings.change',
        actor_id: 'user-1',
        actor_email: 'owner@example.com',
        actor_name: 'Owner',
        message: SERVER_MESSAGE,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'audit-null-details',
        action: 'organization.settings.change',
        actor_id: 'user-1',
        actor_email: 'owner@example.com',
        actor_name: 'Owner',
        details: null,
        message: SERVER_MESSAGE,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const { renderer, unmount } = await mount();

    const texts = renderer.root.findAllByType('Text');
    const messages = texts
      .map(node => node.props.children)
      .filter(child => typeof child === 'string');
    // Two rows, each naming its event and its actor, and nothing else.
    expect(messages.filter(text => text === 'Settings changed')).toHaveLength(2);
    expect(messages.filter(text => text === 'owner@example.com')).toHaveLength(2);
    // No detail line, no server sentence, and so no clamp and no disclosure.
    expect(texts.some(node => node.props.numberOfLines === 2)).toBe(false);
    expect(messages).not.toContain(SERVER_MESSAGE);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    unmount();
  });

  it('clamps a long detail line to two lines and reveals it on one press', async () => {
    pageHook.entries = [longEntry()];
    const { renderer, unmount } = await mount();

    const expected = detailFor(LONG_DETAIL);
    expect(expected.length).toBeGreaterThan(200);
    // The node holds the whole sentence even while the layout clips it: the
    // bound is a layout prop, not a truncation of the copy.
    expect(detailLine(renderer, LONG_DETAIL)?.props.children).toBe(expected);
    expect(detailLine(renderer, LONG_DETAIL)?.props.numberOfLines).toBe(2);
    // The detail is built from the payload, never from the server's sentence.
    expect(
      renderer.root.findAllByType('Text').some(node => node.props.children === SERVER_MESSAGE)
    ).toBe(false);

    await pressDisclosure(renderer);
    // The same text node stays; the press drops the bound rather than swapping
    // in a second, fuller copy.
    expect(detailLine(renderer, LONG_DETAIL)?.props.children).toBe(expected);
    expect(detailLine(renderer, LONG_DETAIL)?.props.numberOfLines).toBeUndefined();

    await pressDisclosure(renderer);
    expect(detailLine(renderer, LONG_DETAIL)?.props.numberOfLines).toBe(2);
    unmount();
  });

  it('reports the disclosure and the whole detail to assistive technology', async () => {
    pageHook.entries = [longEntry()];
    const { renderer, unmount } = await mount();

    const expected = detailFor(LONG_DETAIL);
    const pressables = renderer.root.findAllByType('Pressable');
    expect(pressables.filter(node => disclosureState(node) === false)).toHaveLength(1);
    const closed = pressables.find(node => disclosureState(node) === false);
    expect(closed?.props.accessibilityRole).toBe('button');
    // The clamp is visual only: a reader reaches the whole line unopened.
    expect(closed?.props.accessibilityLabel).toContain(expected);

    await pressDisclosure(renderer);
    const open = renderer.root
      .findAllByType('Pressable')
      .find(node => disclosureState(node) === true);
    expect(open).toBeDefined();
    expect(open?.props.accessibilityRole).toBe('button');
    expect(open?.props.accessibilityLabel).toContain(expected);
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
    // The unknown action hides only the event name: its structured detail still
    // renders, and the wire identifier never reaches the screen.
    expect(messages).toContain(detailFor(entryDetail(0)));
    expect(messages).not.toContain('Audit event 0');
    expect(messages.some(text => text.includes('organization.future.action'))).toBe(false);
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
    expect(messages).toContain(detailFor(entryDetail(0)));

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

  it('draws the static band above the list with the same control', async () => {
    // The band is the pull's visible half under reduced motion, so it sits
    // beside the scroller rather than inside it: inside, its reserve would move
    // the first row at rest and scroll away with the rows.
    pageHook.entries = entries(2);
    pageHook.hasMore = true;
    const { renderer, unmount } = await mount();

    const bands = renderer.root.findAllByType('RefreshProgress');
    expect(bands).toHaveLength(1);
    const [list] = renderer.root.findAllByType('FlashList');
    if (!list) {
      throw new Error('the rows were not handed to the list');
    }
    expect(bands[0]?.props.refreshControl).toBe(list.props.refreshControl);
    unmount();
  });

  it('draws no band where there is no pull control', async () => {
    // The empty state's own centered scroller carries the band, and the
    // first-page error renders no pull at all, so the screen adds neither its
    // own band nor a pull in either branch. (`EmptyState` is stubbed here, so
    // what this counts is the screen's own band.)
    const empty = await mount();
    expect(empty.renderer.root.findAllByType('RefreshProgress')).toHaveLength(0);
    empty.unmount();

    pageQuery.isError = true;
    pageQuery.data = { pages: [], pageParams: [] };
    const failed = await mount();
    expect(failed.renderer.root.findAllByType('RefreshProgress')).toHaveLength(0);
    failed.unmount();
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
