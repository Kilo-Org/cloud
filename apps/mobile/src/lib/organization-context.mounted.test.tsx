/* eslint-disable max-lines -- test-renderer mounts the provider with the real query cache. */
import { createElement } from 'react';
import { onlineManager, type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { ORGANIZATION_PERSONAL_STORAGE_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

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

let current: ReturnType<typeof useOrganization> | undefined = undefined;
const publications: { token: string | undefined; id: string | null; loaded: boolean }[] = [];
type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;
const mounted: Mounted[] = [];
let client: QueryClient | undefined = undefined;

function Probe() {
  current = useOrganization();
  publications.push({ token: auth.token, id: current.organizationId, loaded: current.isLoaded });
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

async function mount(): Promise<Mounted> {
  const ui = await renderWithProviders(createElement(Probe), { wrapper: OrganizationProvider });
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
  list.mockReset().mockResolvedValue([]);
  onlineManager.setOnline(true);
});

afterEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
  onlineManager.setOnline(true);
});

describe('OrganizationProvider default organization', () => {
  it('publishes a stored organization without waiting for the list', async () => {
    savedMetadata.set(ORG_KEY, 'org-b');
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: true, error: null });
    await act(() => {
      names.resolve([orgA]);
    });
    expect(scope().organizationId).toBe('org-b');
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

  it('resolves to Personal while the list is paused offline, then applies the default when it arrives', async () => {
    onlineManager.setOnline(false);
    const names = Promise.withResolvers<OrgEntry[]>();
    list.mockReturnValue(names.promise);
    await mount();
    // A paused list may never fetch: waiting on it would leave the provider
    // unresolved forever, so the app settles on Personal and stays usable.
    await waitFor(() => scope().isLoaded);
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: null });
    // Back online the default still resolves from the list.
    onlineManager.setOnline(true);
    await act(() => {
      names.resolve([orgA]);
    });
    await waitFor(() => scope().organizationId === 'org-a');
    expect(scope()).toMatchObject({ isLoaded: true, error: null });
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
    list.mockResolvedValue([orgA]);

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
