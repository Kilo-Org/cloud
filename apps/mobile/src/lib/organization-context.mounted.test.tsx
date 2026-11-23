/* eslint-disable max-lines -- test-renderer mounts the provider with the real query cache. */
import { createElement } from 'react';
import { onlineManager, type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  type OrganizationContextValue,
  OrganizationProvider,
  type OrganizationSelection,
  useOrganization,
} from '@/lib/organization-context';
import { ORGANIZATION_PERSONAL_STORAGE_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

const ORG_KEY = ORGANIZATION_STORAGE_KEY;
/**
 * The settled "Personal was chosen" marker, shared with the provider and the
 * sign-out cleanup. It is a SECOND key so an explicit Personal choice survives
 * the organization key's deletion, which now means 'not chosen yet' rather
 * than Personal.
 */
const MARKER_KEY = ORGANIZATION_PERSONAL_STORAGE_KEY;

const auth = vi.hoisted(() => ({ token: 'token-a' as string | undefined }));
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
const list = vi.hoisted(() => vi.fn());

// The provider now announces the lost-membership recovery through the
// toast adapter, whose module graph reaches react-native's Flow source
// the mounted transform cannot parse. Suites mock the adapter (not the
// sonner package) so the mock sits at the edge that imports it.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth }));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: storage.read,
  setItemAsync: storage.write,
  deleteItemAsync: storage.remove,
}));
// The provider reads the shared `organizations.list` query through the same
// shape `context-control.mounted.test.tsx` mocks.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations-list'], queryFn: list }) },
    },
  }),
}));

type OrgEntry = { organizationId: string; organizationName: string; role: string };
const orgA: OrgEntry = { organizationId: 'org-a', organizationName: 'Org A', role: 'owner' };
const orgB: OrgEntry = { organizationId: 'org-b', organizationName: 'Org B', role: 'owner' };

const savedMetadata = new Map<string, string>();

let current: OrganizationContextValue | undefined = undefined;
const publications: {
  token: string | undefined;
  id: string | null;
  loaded: boolean;
  status: OrganizationSelection['status'];
}[] = [];
type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;
const mounted: Mounted[] = [];
let client: QueryClient | undefined = undefined;

function Probe() {
  current = useOrganization();
  publications.push({
    token: auth.token,
    id: current.organizationId,
    loaded: current.isLoaded,
    status: current.selection.status,
  });
  return createElement('Scope', current);
}

function scope() {
  if (!current) {
    throw new Error('provider did not publish');
  }
  return current;
}

/** The exact tree `renderWithProviders` builds, so `renderer.update` keeps the client. */
function tree() {
  if (!client) {
    throw new Error('query client not captured');
  }
  return createElement(
    QueryClientProvider,
    { client },
    createElement(OrganizationProvider, null, createElement(Probe))
  );
}

/**
 * Pass `queryClient` to mount over a cache seeded before the tree exists — what
 * the encrypted read-cache restore does on a cold start. A seeded query is
 * `isFetched` while `isFetchedAfterMount` stays false, because the observer's
 * initial state already holds that data.
 */
async function mount(queryClient?: QueryClient): Promise<Mounted> {
  const ui = await renderWithProviders(createElement(Probe), {
    wrapper: OrganizationProvider,
    queryClient,
  });
  client = ui.queryClient;
  mounted.push(ui);
  return ui;
}

async function rerender(): Promise<void> {
  await act(() => {
    mounted.at(-1)?.renderer.update(tree());
  });
}

function unmount(ui: Mounted): void {
  const index = mounted.indexOf(ui);
  if (index !== -1) {
    mounted.splice(index, 1);
  }
  ui.unmount();
}

beforeEach(() => {
  auth.token = 'token-a';
  bumpAuthEpoch();
  current = undefined;
  client = undefined;
  publications.length = 0;
  savedMetadata.clear();
  storage.read.mockReset().mockImplementation(async (key: string) => {
    await Promise.resolve();
    return savedMetadata.get(key) ?? null;
  });
  storage.write.mockReset().mockImplementation(async (key: string, value: string) => {
    savedMetadata.set(key, value);
    await Promise.resolve();
  });
  storage.remove.mockReset().mockImplementation(async (key: string) => {
    savedMetadata.delete(key);
    await Promise.resolve();
  });
  // The default list holds both fixture organizations: a stored selection
  // missing from the fetched list now recovers to the first membership, so
  // the fencing tests below stage their own list payloads explicitly.
  list.mockReset().mockResolvedValue([orgA, orgB]);
  onlineManager.setOnline(true);
});

afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
  onlineManager.setOnline(true);
});

describe('OrganizationProvider default organization', () => {
  it('holds a stored organization pending until the list confirms it', async () => {
    savedMetadata.set(ORG_KEY, 'org-b');
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    // The stored id is published, but the selection is NOT loaded: nothing may
    // load a membership the list has not confirmed. This is the window a
    // deleted organization used to paint its name and a failed session load in.
    expect(scope()).toMatchObject({
      organizationId: 'org-b',
      isLoaded: false,
      error: null,
      selection: { status: 'restored', organizationId: 'org-b' },
    });
    await act(() => {
      names.resolve([orgA, orgB]);
    });
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({
      organizationId: 'org-b',
      isLoaded: true,
      error: null,
      selection: { status: 'organization', organizationId: 'org-b' },
    });
  });

  it('defaults to the first organization when nothing is stored', async () => {
    list.mockResolvedValue([orgA, orgB]);
    await mount();
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: null });
  });

  it('writes the default organization to the key non-React scope readers use', async () => {
    list.mockResolvedValue([orgA, orgB]);
    await mount();
    await waitFor(() => savedMetadata.get(ORG_KEY) === 'org-a');
    expect(savedMetadata.has(MARKER_KEY)).toBe(false);
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: null });
    await waitFor(() => !scope().isSaving);
  });

  it('resolves an empty list to Personal', async () => {
    list.mockResolvedValue([]);
    await mount();
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: null });
    // Personal from an empty list is not an explicit choice: neither key is
    // written, so a later list with organizations still resolves its default.
    expect(savedMetadata.has(ORG_KEY)).toBe(false);
    expect(savedMetadata.has(MARKER_KEY)).toBe(false);
  });

  it('keeps Personal and reports a list failure without spinning', async () => {
    list.mockRejectedValue(new Error('offline'));
    await mount();
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: 'restore' });
    expect(publications.some(value => value.loaded && value.id === null)).toBe(true);
  });

  it('keeps the provider resolving while the offline list fetch is still running', async () => {
    // The list read carries `SETTLE_WHILE_OFFLINE`, so a fetch the manager went
    // offline during still runs and settles (answer or deadline failure); the
    // provider waits for that settled snapshot instead of publishing Personal
    // from a paused read.
    onlineManager.setOnline(false);
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: false, error: null });
    // The fetch settles by failing (the deadline/transport deadline path): the
    // restore error is the only offline outcome the provider publishes.
    await act(() => {
      names.reject(new Error('offline'));
    });
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: 'restore' });
    onlineManager.setOnline(true);
  });

  it('re-resolves the default through Retry after a list failure', async () => {
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([orgA]);
    await mount();
    await waitFor(() => scope().error === 'restore');
    await act(() => {
      scope().retry();
    });
    await waitFor(() => scope().error === null && scope().isLoaded);
    expect(scope().organizationId).toBe('org-a');
  });

  it('writes the explicit Personal marker when Personal is chosen while already auto-resolved', async () => {
    list.mockResolvedValue([]);
    await mount();
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true });
    // Auto-resolved Personal from an empty list is not an explicit choice, so
    // no marker is written yet.
    expect(savedMetadata.has(MARKER_KEY)).toBe(false);
    await act(() => {
      scope().setOrganizationId(null);
    });
    // Selecting Personal explicitly must record the choice even though the
    // published id did not change, or a later list with organizations would
    // move the person back to one on the next launch.
    await waitFor(() => savedMetadata.get(MARKER_KEY) === 'personal');
    expect(savedMetadata.has(ORG_KEY)).toBe(false);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true });
  });

  it('keeps an explicit Personal marker across a re-mount with organizations available', async () => {
    savedMetadata.set(MARKER_KEY, 'personal');
    list.mockResolvedValue([orgA]);
    const first = await mount();
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: null });
    // An explicit Personal choice is not overridden by the default, so the
    // organization key stays absent for every other scope reader too.
    expect(savedMetadata.has(ORG_KEY)).toBe(false);
    unmount(first);
    await mount();
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: null });
  });

  it('publishes nothing stale when a sign-out lands during the list fetch', async () => {
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    expect(scope().isLoaded).toBe(false);
    auth.token = undefined;
    await rerender();
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: null });
    await act(() => {
      names.resolve([orgA]);
    });
    expect(scope().organizationId).toBeNull();
    expect(publications.some(value => value.loaded && value.id !== null)).toBe(false);
  });

  it('attributes a late list result to the newer sign-in, never the old token', async () => {
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    auth.token = 'token-b';
    await rerender();
    expect(
      publications.filter(value => value.token === 'token-b').every(value => !value.loaded)
    ).toBe(true);
    await act(() => {
      names.resolve([orgA]);
    });
    await waitFor(() => scope().isLoaded);
    expect(
      publications.filter(value => value.token === 'token-a' && value.id === 'org-a')
    ).toHaveLength(0);
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: null });
  });
});

describe('OrganizationProvider restoration fencing', () => {
  it('never publishes Personal before a delayed saved organization', async () => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValue(read.promise);
    await mount();
    expect(scope().isLoaded).toBe(false);
    await act(() => {
      read.resolve('org-a');
    });
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: null });
    expect(publications.some(value => value.loaded && value.id === null)).toBe(false);
  });

  it('keeps a failed read unresolved and retries restoration', async () => {
    storage.read.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue('org-a');
    await mount();
    expect(scope()).toMatchObject({ isLoaded: false, error: 'restore' });
    expect(publications.some(value => value.loaded)).toBe(false);
    await act(() => {
      scope().retry();
    });
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: null });
  });

  it('honors a saved organization when the Personal marker read fails', async () => {
    savedMetadata.set(ORG_KEY, 'org-b');
    storage.read.mockImplementation(async (key: string) => {
      await Promise.resolve();
      if (key === MARKER_KEY) {
        throw new Error('marker read failed');
      }
      return savedMetadata.get(key) ?? null;
    });
    // The fetched list holds the saved organization, so the selection survives.
    list.mockResolvedValue([orgA, orgB]);

    await mount();
    await waitFor(() => scope().isLoaded);

    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: true, error: null });
    // A stored organization is its own answer, so the marker is never read and
    // its failure cannot discard the saved selection.
    expect(storage.read).not.toHaveBeenCalledWith(MARKER_KEY);
  });

  it('reports a restore error when the marker read fails with no saved organization', async () => {
    storage.read.mockImplementation(async (key: string) => {
      await Promise.resolve();
      if (key === MARKER_KEY) {
        throw new Error('marker read failed');
      }
      return null;
    });

    await mount();

    // Neither key is readable, so the required selection state is unknown and
    // the existing restore error stands.
    expect(scope()).toMatchObject({ isLoaded: false, error: 'restore' });
    expect(storage.read).toHaveBeenCalledWith(MARKER_KEY);
  });

  it.each(['resolve', 'reject'])('ignores an obsolete read %s after selection', async outcome => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValue(read.promise);
    await mount();
    await act(() => {
      scope().setOrganizationId('org-b');
    });
    await act(() => {
      if (outcome === 'resolve') {
        read.resolve('org-a');
      } else {
        read.reject(new Error('obsolete'));
      }
    });
    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: true, error: null });
  });

  it('ignores a read after a token change', async () => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValueOnce(read.promise).mockResolvedValue('org-b');
    await mount();
    auth.token = 'token-b';
    await rerender();
    await act(() => {
      read.resolve('org-a');
    });
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: true, error: null });
  });

  it('ignores a read after an epoch bump', async () => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValueOnce(read.promise).mockResolvedValue('org-b');
    await mount();
    bumpAuthEpoch();
    await act(() => {
      read.resolve('org-a');
    });
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: false, error: null });
  });

  it('settles a pending default when the user selects the placeholder value', async () => {
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    await act(() => {
      scope().setOrganizationId(null);
    });
    await act(() => {
      names.resolve([orgA]);
    });
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true });
    expect(savedMetadata.get(MARKER_KEY)).toBe('personal');
  });
});

describe('OrganizationProvider persistence', () => {
  it('writes the organization key and clears the Personal marker', async () => {
    await mount();
    await waitFor(() => scope().isLoaded);
    await act(() => {
      scope().setOrganizationId('org-a');
    });
    await waitFor(() => !scope().isSaving);
    expect(savedMetadata.get(ORG_KEY)).toBe('org-a');
    expect(savedMetadata.has(MARKER_KEY)).toBe(false);
    expect(scope()).toMatchObject({ organizationId: 'org-a', error: null });
  });

  it('deletes the organization key and writes the Personal marker', async () => {
    savedMetadata.set(ORG_KEY, 'org-a');
    await mount();
    await waitFor(() => scope().isLoaded);
    await act(() => {
      scope().setOrganizationId(null);
    });
    await waitFor(() => !scope().isSaving);
    expect(savedMetadata.has(ORG_KEY)).toBe(false);
    expect(savedMetadata.get(MARKER_KEY)).toBe('personal');
    expect(scope()).toMatchObject({ organizationId: null, error: null });
  });

  it('keeps the selection and reports a save failure, then retries persistence', async () => {
    savedMetadata.set(ORG_KEY, 'previous-org');
    storage.write.mockRejectedValueOnce(new Error('write failed'));
    await mount();
    await waitFor(() => scope().isLoaded);
    await act(() => {
      scope().setOrganizationId('org-a');
    });
    await waitFor(() => scope().error === 'save');
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: 'save' });
    expect(savedMetadata.get(ORG_KEY)).toBe('previous-org');
    await act(() => {
      scope().retry();
    });
    await waitFor(() => savedMetadata.get(ORG_KEY) === 'org-a' && !scope().isSaving);
    expect(scope()).toMatchObject({ organizationId: 'org-a', error: null });
    expect(savedMetadata.has(MARKER_KEY)).toBe(false);
  });

  it('keeps a save busy until storage settles', async () => {
    const save = Promise.withResolvers<undefined>();
    storage.write.mockImplementationOnce(async () => {
      await save.promise;
    });
    await mount();
    await waitFor(() => scope().isLoaded);
    await act(() => {
      scope().setOrganizationId('org-a');
    });
    expect(scope().isSaving).toBe(true);
    await act(() => {
      save.resolve(undefined);
    });
    await waitFor(() => !scope().isSaving);
    expect(scope()).toMatchObject({ organizationId: 'org-a', error: null });
  });
});

describe('OrganizationProvider deleted membership', () => {
  it('keeps a restored organization pending while the list is in flight', async () => {
    // The device sequence: an organization the person belonged to is deleted
    // while the app is closed, so the stored id names nothing. On relaunch the
    // stored id is published before `organizations.list` answers.
    savedMetadata.set(ORG_KEY, 'org-gone');
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);

    await mount();

    expect(scope()).toMatchObject({
      organizationId: 'org-gone',
      isLoaded: false,
      error: null,
      selection: { status: 'restored', organizationId: 'org-gone' },
    });
    // Nothing may report a failure for an organization no settled list has
    // named: no publication before the answer is loaded, and no error.
    expect(publications.filter(value => value.loaded)).toHaveLength(0);
    expect(publications.some(value => value.id === 'org-gone' && value.loaded)).toBe(false);
  });

  it('switches to Personal once the list settles without the stored organization', async () => {
    savedMetadata.set(ORG_KEY, 'org-gone');
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    expect(scope().isLoaded).toBe(false);

    await act(() => {
      names.resolve([]);
    });

    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({
      organizationId: null,
      isLoaded: true,
      error: null,
      selection: { status: 'personal-chosen' },
    });
    // Personal is written as an explicit choice, so the dead id never returns.
    await waitFor(() => savedMetadata.get(MARKER_KEY) === 'personal');
    expect(savedMetadata.has(ORG_KEY)).toBe(false);
    // The switch happened after the answer, never before it.
    const firstLoaded = publications.find(value => value.loaded);
    expect(firstLoaded?.id).toBeNull();
  });

  it('keeps the organization when the settled list still names it', async () => {
    savedMetadata.set(ORG_KEY, 'org-b');
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    expect(scope().isLoaded).toBe(false);

    await act(() => {
      names.resolve([orgA, orgB]);
    });

    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({
      organizationId: 'org-b',
      isLoaded: true,
      error: null,
      selection: { status: 'organization', organizationId: 'org-b' },
    });
    // A confirmed membership is not rewritten: the pair already names it.
    expect(savedMetadata.get(ORG_KEY)).toBe('org-b');
    expect(savedMetadata.has(MARKER_KEY)).toBe(false);
  });

  it('switches to the first remaining membership when the stored organization is gone', async () => {
    savedMetadata.set(ORG_KEY, 'org-gone');
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    await act(() => {
      names.resolve([orgA]);
    });
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({
      organizationId: 'org-a',
      selection: { status: 'organization', organizationId: 'org-a' },
    });
  });

  it('does not confirm a restored organization from a hydrated list snapshot', async () => {
    savedMetadata.set(ORG_KEY, 'org-b');
    // The encrypted read cache restored this query: it answers from a previous
    // run, so it is `isFetched` without being an answer to this mount.
    const seeded = createTestQueryClient();
    seeded.setQueryData(['organizations-list'], [orgA, orgB]);
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReset().mockReturnValue(names.promise);

    await mount(seeded);

    // The snapshot names the stored organization, and it still cannot confirm
    // it: the selection waits for a read that answers after this mount.
    await waitFor(() => scope().selection.status === 'restored');
    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: false, error: null });
    expect(publications.some(value => value.status === 'organization')).toBe(false);
    // The provider asks for that answer exactly once, because the query's own
    // staleness would have served the hydrated snapshot without a request.
    expect(list).toHaveBeenCalledTimes(1);

    await act(() => {
      names.resolve([orgA, orgB]);
    });

    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({
      organizationId: 'org-b',
      isLoaded: true,
      selection: { status: 'organization', organizationId: 'org-b' },
    });
  });

  it('does not recover from a hydrated list snapshot that misses the restored organization', async () => {
    savedMetadata.set(ORG_KEY, 'org-b');
    // A stale snapshot from the previous run that does not name the stored
    // organization. Acting on it would switch the person off a membership the
    // server still serves.
    const seeded = createTestQueryClient();
    seeded.setQueryData(['organizations-list'], [orgA]);
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReset().mockReturnValue(names.promise);

    await mount(seeded);

    await waitFor(() => scope().selection.status === 'restored');
    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: false, error: null });
    // No switch to the snapshot's only membership, and no write of it.
    expect(publications.some(value => value.id === 'org-a')).toBe(false);
    expect(savedMetadata.get(ORG_KEY)).toBe('org-b');
    expect(list).toHaveBeenCalledTimes(1);

    await act(() => {
      names.resolve([orgA, orgB]);
    });

    await waitFor(() => scope().isLoaded);
    // The server still serves the membership, so the selection stands.
    expect(scope()).toMatchObject({
      organizationId: 'org-b',
      selection: { status: 'organization', organizationId: 'org-b' },
    });
    expect(publications.some(value => value.id === 'org-a')).toBe(false);
  });

  it('publishes the stored id as unverified when the list fails, and promotes it after Retry', async () => {
    savedMetadata.set(ORG_KEY, 'org-b');
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([orgB]);
    await mount();

    // A failed read is not an answer about the membership: the id is published
    // so the surfaces can show the list's own failure and its Retry.
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({
      organizationId: 'org-b',
      isLoaded: true,
      selection: { status: 'restored-unverified', organizationId: 'org-b' },
    });

    await act(() => {
      scope().retry();
    });

    await waitFor(() => scope().selection.status === 'organization' && scope().error === null);
    expect(scope()).toMatchObject({
      organizationId: 'org-b',
      isLoaded: true,
      error: null,
    });
  });
});
