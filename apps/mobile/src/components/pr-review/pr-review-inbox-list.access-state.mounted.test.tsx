// A refused organization keeps its own screen of the inbox.
//
// The explorer left PR Review open in an organization, had the membership
// removed, and got a transient "try again shortly" retry whose every attempt
// was refused again — the organization itself was gone, not the provider. The
// inbox must say so and offer the scope that still works, so this suite pins the
// view down: which copy each refusal gets, that the rows read under it are gone,
// that no provider-recovery chrome claims the surface, and that the action
// switches the account context to personal.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewInboxList } from './pr-review-inbox-list';

const inboxState = vi.hoisted(() => ({
  organizationScopeAccess: 'granted' as 'granted' | 'denied' | 'not-found',
  firstPageErrorState: null as { kind: string } | null,
  githubNeedsReconnect: false,
  setOrganizationId: vi.fn(),
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shopify/flash-list', async () => {
  // A `vi.mock` factory is hoisted above the module imports, so React can only
  // be reached here through a dynamic import.
  const react = await import('react');
  return {
    FlashList: (props: {
      data?: unknown[];
      renderItem?: (args: { item: unknown }) => React.ReactElement | null;
      ListEmptyComponent?: React.ReactElement;
      ListFooterComponent?: React.ReactElement;
    }) => {
      const rows = props.data ?? [];
      return react.createElement(
        'FlashList',
        null,
        ...rows.map(item => props.renderItem?.({ item }) ?? null),
        rows.length === 0 ? (props.ListEmptyComponent ?? null) : null,
        props.ListFooterComponent ?? null
      );
    },
  };
});
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  Clock: 'Clock',
  GitPullRequest: 'GitPullRequest',
  Inbox: 'Inbox',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: 'org-1',
    setOrganizationId: inboxState.setOrganizationId,
  }),
}));
vi.mock('@/lib/pr-review/use-provider-inbox', () => ({
  useProviderInbox: () => ({
    query: {
      isPending: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    },
    githubNeedsReconnect: inboxState.githubNeedsReconnect,
    isPending: false,
    isFetching: false,
    retryFailedPages: vi.fn(),
    items: [
      {
        ref: {
          platform: 'github' as const,
          owner: 'octocat',
          repo: 'hello-world',
          number: 7,
        },
        key: 'octocat/hello-world#7',
        title: 'Fix the thing',
        isDraft: false,
        updatedAt: '2026-09-01T12:00:00Z',
      },
    ],
    firstPageErrorState: inboxState.firstPageErrorState,
    firstPageErrorPlatform: null,
    laterPageError: false,
    organizationScopeAccess: inboxState.organizationScopeAccess,
  }),
}));
vi.mock('@/lib/utils', () => ({
  parseTimestamp: (value: string) => new Date(value),
  timeAgo: () => 'just now',
}));

function mountInboxList(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(PrReviewInboxList, { header: null, recents: null })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function accessError(renderer: TestRenderer.ReactTestRenderer) {
  const errors = renderer.root.findAll(node => String(node.type) === 'QueryError');
  const [error] = errors;
  if (!error || errors.length !== 1) {
    throw new Error(`expected one QueryError, received ${String(errors.length)}`);
  }
  return error;
}

type ActionElement = {
  props: { accessibilityLabel?: unknown; onPress?: unknown };
};

function isActionElement(value: unknown): value is ActionElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    'props' in value &&
    typeof value.props === 'object' &&
    value.props !== null
  );
}

// `QueryError` is a mocked host component, so the `action` element it was handed
// is not mounted as a child; the element itself is the assertion.
function continueInPersonalPress(renderer: TestRenderer.ReactTestRenderer): () => void {
  const action: unknown = accessError(renderer).props.action;
  if (
    !isActionElement(action) ||
    typeof action.props.accessibilityLabel !== 'string' ||
    typeof action.props.onPress !== 'function'
  ) {
    throw new Error('the access state rendered no action button');
  }
  expect(action.props.accessibilityLabel).toBe('prReview.inbox.continueInPersonal');
  // The mock host element's handler is an opaque function prop.
  const press = action.props.onPress as () => void;
  return press;
}

function inboxRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'octocat/hello-world#7'
  );
}

describe('PrReviewInboxList organization access state', () => {
  beforeEach(() => {
    inboxState.organizationScopeAccess = 'granted';
    inboxState.firstPageErrorState = null;
    inboxState.githubNeedsReconnect = false;
    inboxState.setOrganizationId.mockClear();
  });

  it('explains a removed membership and drops the rows read under it', () => {
    inboxState.organizationScopeAccess = 'denied';
    const renderer = mountInboxList();

    expect(accessError(renderer).props).toMatchObject({
      variant: 'permission',
      title: 'prReview.inbox.accessLostTitle',
      message: 'prReview.inbox.accessLostDescription',
    });
    expect(inboxRows(renderer)).toHaveLength(0);
    // No Retry: the refused read cannot start working again on its own.
    expect(
      renderer.root.findAll(
        node => String(node.type) === 'Button' && node.props.accessibilityLabel === 'common.retry'
      )
    ).toHaveLength(0);
  });

  it('reports a deleted organization as unavailable', () => {
    inboxState.organizationScopeAccess = 'not-found';
    const renderer = mountInboxList();

    expect(accessError(renderer).props).toMatchObject({
      variant: 'not-found',
      title: 'prReview.inbox.organizationUnavailableTitle',
      message: 'prReview.inbox.organizationUnavailableDescription',
    });
  });

  it('outranks a provider reconnection the reader cannot complete', () => {
    inboxState.organizationScopeAccess = 'denied';
    inboxState.firstPageErrorState = { kind: 'reconnect' };
    inboxState.githubNeedsReconnect = true;
    const renderer = mountInboxList();

    expect(accessError(renderer).props.title).toBe('prReview.inbox.accessLostTitle');
    expect(
      renderer.root.findAll(node => String(node.type) === 'PrReviewReconnectNotice')
    ).toHaveLength(0);
  });

  it('continues in the personal scope when the reader taps the action', () => {
    inboxState.organizationScopeAccess = 'denied';
    const renderer = mountInboxList();

    act(() => {
      continueInPersonalPress(renderer)();
    });

    expect(inboxState.setOrganizationId).toHaveBeenCalledWith(null);
  });

  it('leaves a granted organization on its rows', () => {
    const renderer = mountInboxList();

    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    expect(inboxRows(renderer)).toHaveLength(1);
  });
});
