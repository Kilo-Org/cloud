// The scope landing's organization rows follow the membership payload, not a
// loading flag: the read is gated on the auth token, so before that token
// resolves it is neither loading nor answered. A delivered list therefore stays
// on screen even when a background refetch fails over it, and only a read that
// failed with nothing delivered owns the banner; the placeholder stands in for
// a read that never delivered. The cases below pin all four states.

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type TestRenderer } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { ScopeListScreen } from './scope-list-screen';

type Membership = { organizationId: string; organizationName: string; role: string };

type ListState = {
  data: Membership[] | undefined;
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
};

/** The memberships read, driven per test: the screen's only input. */
const memberships = vi.hoisted(() => ({
  data: undefined as Membership[] | undefined,
  error: undefined as unknown,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle' as ListState['fetchStatus'],
  refetch: vi.fn<() => void>(),
}));

/** The connection the offline banner state reports, driven per test. */
const connectivity = vi.hoisted(() => ({ status: 'online' as 'online' | 'offline' | 'unknown' }));

vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => connectivity.status,
}));

const MEMBERSHIPS: Membership[] = [
  { organizationId: 'org_1', organizationName: 'Drain Labs', role: 'owner' },
  { organizationId: 'org_2', organizationName: 'Acme Support', role: 'member' },
];

vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: (): ListState => memberships,
}));

// The screen reads one value from the reviewer hook module, whose own graph
// reaches tRPC, the toast adapter and the organization queries.
vi.mock('@/lib/hooks/use-code-reviewer', () => ({ PERSONAL_SCOPE: 'personal' }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: () => undefined,
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; subtitle?: string }) =>
    createElement('ScreenHeaderMock', props),
}));

// The banner paints its title and message as text, the way the real surface
// does, so the screen's own copy is what the assertions read.
vi.mock('@/components/query-error', () => ({
  QueryError: (props: { variant?: string; title?: string; message?: string }) =>
    createElement(
      'QueryErrorMock',
      props,
      createElement('Text', null, props.title),
      createElement('Text', null, props.message)
    ),
}));

// The row's title and subtitle are what the real primitive paints as text; the
// stub keeps them in the tree so a test finds a row by its name.
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title?: string; subtitle?: string; onPress?: () => void }) =>
    createElement(
      'ConfigureRowMock',
      props,
      createElement('Text', null, props.title),
      createElement('Text', null, props.subtitle)
    ),
}));

vi.mock('@/components/ui/row-group', () => ({
  RowGroup: (props: { leadingTile?: boolean; children?: ReactNode }) =>
    createElement('RowGroupMock', props, props.children),
}));
// The primitive carries no test handle of its own, so the stub's host name is
// the one a test counts; its `tile`/`subtitle` props stay readable on the node.
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/icons', () => ({ Building2: 'Building2', User: 'User' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }) =>
    createElement('TabScreenScrollView', props, props.children),
}));
vi.mock('react-native', () => ({ View: 'View' }));

let view: RenderWithProvidersResult | undefined = undefined;

beforeEach(() => {
  memberships.data = undefined;
  memberships.error = undefined;
  memberships.isError = false;
  memberships.isFetching = false;
  memberships.fetchStatus = 'idle';
  memberships.refetch.mockReset();
  connectivity.status = 'online';
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function mountScreen(): Promise<TestRenderer.ReactTestInstance> {
  view = await renderWithProviders(createElement(ScopeListScreen));
  return view.renderer.root;
}

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The screen's rendered copy, one entry per text node. */
function texts(root: TestRenderer.ReactTestInstance): string[] {
  return findByType(root, 'Text')
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

type RowProps = { title?: string; subtitle?: string };

function rows(root: TestRenderer.ReactTestInstance): RowProps[] {
  return findByType(root, 'ConfigureRowMock').map(node => node.props as RowProps);
}

describe('ScopeListScreen organization rows', () => {
  it('holds one placeholder row until the membership read answers', async () => {
    const root = await mountScreen();

    const placeholders = findByType(root, 'RowSkeleton');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]?.props.tile).toBe(true);
    expect(placeholders[0]?.props.subtitle).toBe(true);
    expect(findByType(root, 'QueryErrorMock')).toHaveLength(0);
    // The Personal scope is not a membership: it paints whatever the read does.
    expect(texts(root)).toContain('Personal');
  });

  it('paints the error banner alone, with no placeholder that could outlive it', async () => {
    // A served answer is the server's failure, so the banner keeps the system
    // wording even when the device also reports itself offline.
    memberships.isError = true;
    // A tRPC envelope is what `readTrpcErrorField` reads as a server answer.
    memberships.error = Object.assign(new Error('boom'), {
      data: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' },
    });
    const root = await mountScreen();

    const banner = findByType(root, 'QueryErrorMock')[0];
    expect(banner?.props.variant).toBe('server');
    expect(texts(root)).toContain('Could not load organizations');
    expect(texts(root)).toContain('Personal repositories are still available below.');
    expect(findByType(root, 'RowSkeleton')).toHaveLength(0);
    // The banner promises Personal is still below, so the row stays.
    expect(rows(root).map(row => row.title)).toEqual(['Personal']);
  });

  it('names the connection for a failed read that never reached the server', async () => {
    // The shared read settles instead of pausing (`networkMode: 'always'`), so
    // a confirmed-offline cold start fails with a transport error rather than
    // a paused read; the failure's own cause, not the list body, picks the copy.
    memberships.isError = true;
    memberships.error = new TypeError('Network request failed');
    connectivity.status = 'offline';
    const root = await mountScreen();

    const banner = findByType(root, 'QueryErrorMock')[0];
    expect(banner?.props.variant).toBe('offline');
    expect(findByType(root, 'RowSkeleton')).toHaveLength(0);
    expect(rows(root).map(row => row.title)).toEqual(['Personal']);
  });

  it('keeps the delivered rows when a background refetch fails over them', async () => {
    memberships.data = MEMBERSHIPS;
    memberships.isError = true;
    const root = await mountScreen();

    // A delivered list is what the reader has; the failure of a later read
    // must not paint a banner above it or take the rows away.
    expect(findByType(root, 'QueryErrorMock')).toHaveLength(0);
    expect(texts(root)).not.toContain('Could not load organizations');
    expect(rows(root).map(row => row.title)).toEqual(['Personal', 'Drain Labs', 'Acme Support']);
    expect(findByType(root, 'RowSkeleton')).toHaveLength(0);
  });

  it('replaces the placeholder with one row per membership', async () => {
    memberships.data = MEMBERSHIPS;
    const root = await mountScreen();

    const rendered = texts(root);
    expect(rendered).toContain('Drain Labs');
    expect(rendered).toContain('Acme Support');
    expect(findByType(root, 'RowSkeleton')).toHaveLength(0);
    expect(rows(root).map(row => row.title)).toEqual(['Personal', 'Drain Labs', 'Acme Support']);
    // Every scope row says what it covers; a member's row says it is read-only.
    expect(rows(root).map(row => row.subtitle)).toEqual([
      'Your own repositories',
      'Organization repositories',
      'View only',
    ]);
  });
});
