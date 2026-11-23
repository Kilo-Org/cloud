import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewSessionModelProvider, useNewSessionModelState } from './new-session-model-provider';
import { act, TestRenderer } from '@/test/renderer';

/** The saved preference one account scope answers with. */
type Preference = {
  favorites: string[];
  lastSelected: { model: string; variant?: string } | null;
};

/**
 * The cache key the mocked router hands out for one account scope. The real
 * router keys the read by organization, so two scopes never share an entry and
 * a moved scope has to resolve from its own read.
 */
function preferenceKey(input?: { organizationId?: string }) {
  return ['modelPreferences', 'get', input ?? null] as const;
}

/** The per-scope answers the mocked hooks and router hand back. */
type FixtureState = {
  catalogs: Record<string, { id: string; name: string; variants: string[] }[]>;
  orgDefaults: Record<
    string,
    { defaultModel?: string; isPending: boolean; isError: boolean; isFetching: boolean }
  >;
  preferences: Record<string, Preference>;
  heldReads: Record<string, Promise<Preference>>;
  prefill: { mode: string };
};

const fixture = vi.hoisted(() => {
  const state: FixtureState = {
    // The catalog each account scope answers with, keyed by scope (`personal`
    // stands in for the organization-less account).
    catalogs: {},
    // The organization-default read's phase per scope, so a moved scope can
    // answer with its own failure.
    orgDefaults: {},
    // The saved preference each scope answers with. A scope with no entry has
    // nothing saved, so it never inherits the previous account's pick.
    preferences: {},
    // The reads a test keeps open, so a moved scope can be observed while its
    // own preference is still loading.
    heldReads: {},
    prefill: { mode: 'code' },
  };
  // Reads the reassigned maps through `state`, so a test that replaces one
  // between cases is the one the next read consults.
  const read = (input?: { organizationId?: string }): Promise<Preference> => {
    const scope = input?.organizationId ?? 'personal';
    const held = state.heldReads[scope];
    if (held) {
      return held;
    }
    return Promise.resolve(state.preferences[scope] ?? { favorites: [], lastSelected: null });
  };
  return Object.assign(state, { read });
});

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: (organizationId: string | undefined) => ({
    models: fixture.catalogs[organizationId ?? 'personal'] ?? [],
    isLoading: false,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
    isFetched: true,
    hasDeliveredData: true,
    error: null,
    refetch: () => undefined,
  }),
  useOrgDefaultModel: (organizationId: string | undefined) => ({
    ...(fixture.orgDefaults[organizationId ?? 'personal'] ?? {
      defaultModel: undefined,
      isPending: false,
      isError: false,
      isFetching: false,
    }),
    refetch: () => undefined,
  }),
}));
vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  usePersistedAgentModel: () => ({ stored: {}, hasLoaded: true }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    modelPreferences: {
      get: {
        queryOptions: (input?: { organizationId?: string }) => ({
          queryKey: preferenceKey(input),
          queryFn: () => fixture.read(input),
          staleTime: Infinity,
        }),
        // Invalidation calls this with no input; the partial key stays stable so
        // a refresh still names the preference read rather than a scope.
        queryKey: (input?: { organizationId?: string }) => preferenceKey(input),
      },
      setLastSelected: { mutationOptions: (options: object) => options },
      clearLastSelected: { mutationOptions: (options: object) => options },
      setFavorites: { mutationOptions: (options: object) => options },
    },
  }),
  trpcClient: {
    modelPreferences: {
      setLastSelected: { mutate: () => Promise.resolve() },
      addFavorite: { mutate: () => Promise.resolve() },
      removeFavorite: { mutate: () => Promise.resolve() },
      setFavorites: { mutate: () => Promise.resolve() },
      clearLastSelected: { mutate: () => Promise.resolve() },
    },
  },
}));
vi.mock('@/components/agents/use-new-session-prefill', () => ({
  useNewSessionPrefill: () => fixture.prefill,
}));

type Snapshot = { model: string; variant: string; modelSelectionFailure: boolean };
let snapshot: Snapshot = { model: '', variant: '', modelSelectionFailure: false };
let chooseModel: (model: string, variant: string) => void = () => {
  throw new Error('Form not mounted');
};
function Consumer() {
  const state = useNewSessionModelState();
  snapshot = {
    model: state.model,
    variant: state.variant,
    modelSelectionFailure: state.modelSelectionFailure !== null,
  };
  chooseModel = (model, variant) => {
    state.setModel(model);
    state.setVariant(variant);
  };
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let client = new QueryClient();
function renderProvider(organizationId: string) {
  const tree = (
    <QueryClientProvider client={client}>
      <NewSessionModelProvider organizationId={organizationId}>
        <Consumer />
      </NewSessionModelProvider>
    </QueryClientProvider>
  );
  if (renderer) {
    renderer.update(tree);
  } else {
    renderer = TestRenderer.create(tree);
  }
}

/**
 * Flush the mocked reads and React Query's notifications. A query notifies its
 * observers on a zero-delay macrotask, so this yields whole turns until
 * `reached` holds; the assertion after it still decides the test's outcome.
 */
async function settle(reached: () => boolean) {
  for (let turn = 0; turn < 20 && !reached(); turn += 1) {
    const tick = Promise.withResolvers<undefined>();
    setTimeout(() => {
      tick.resolve(undefined);
    }, 0);
    // eslint-disable-next-line no-await-in-loop -- each turn must flush the query notification before the next
    await act(async () => {
      await tick.promise;
    });
  }
}

/**
 * Seed one scope's saved preference in both places it can be read from: the
 * cache the form renders from and the answer a refetch would receive, so the
 * two never contradict each other.
 */
function seedPreference(input: { organizationId: string }, preference: Preference) {
  fixture.preferences[input.organizationId] = preference;
  client.setQueryData(preferenceKey(input), preference);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', false);
  fixture.catalogs = {};
  fixture.orgDefaults = {};
  fixture.preferences = {};
  fixture.heldReads = {};
  fixture.prefill = { mode: 'code' };
  snapshot = { model: '', variant: '', modelSelectionFailure: false };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  client.clear();
  vi.unstubAllGlobals();
});

describe('new-session model scope', () => {
  it('resolves the moved scope from its own catalog and preference read', async () => {
    fixture.catalogs = {
      'org-a': [{ id: 'a1', name: 'A1', variants: [] }],
      'org-b': [{ id: 'b1', name: 'B1', variants: [] }],
    };
    seedPreference({ organizationId: 'org-a' }, { favorites: [], lastSelected: { model: 'a1' } });
    act(() => {
      renderProvider('org-a');
    });
    expect(snapshot.model).toBe('a1');

    act(() => {
      renderProvider('org-b');
    });
    await settle(() => snapshot.model === 'b1');
    expect(snapshot.model).toBe('b1');
  });

  it('keeps the explicit pick while the account scope is unchanged', () => {
    fixture.catalogs = { 'org-a': [{ id: 'a1', name: 'A1', variants: [] }] };
    seedPreference({ organizationId: 'org-a' }, { favorites: [], lastSelected: { model: 'a1' } });
    act(() => {
      renderProvider('org-a');
    });
    expect(snapshot.model).toBe('a1');

    act(() => {
      chooseModel('a1', 'v');
    });
    act(() => {
      renderProvider('org-a');
    });
    expect({ model: snapshot.model, variant: snapshot.variant }).toEqual({
      model: 'a1',
      variant: 'v',
    });
  });

  it("reports the moved scope's model-selection failure", async () => {
    fixture.catalogs = {
      'org-a': [{ id: 'a1', name: 'A1', variants: [] }],
      'org-b': [{ id: 'b1', name: 'B1', variants: [] }],
    };
    fixture.orgDefaults = {
      'org-b': { defaultModel: undefined, isPending: false, isError: true, isFetching: false },
    };
    seedPreference({ organizationId: 'org-a' }, { favorites: [], lastSelected: { model: 'a1' } });
    act(() => {
      renderProvider('org-a');
    });
    expect(snapshot.model).toBe('a1');

    act(() => {
      renderProvider('org-b');
    });
    await settle(() => snapshot.modelSelectionFailure);
    expect(snapshot.model).toBe('');
    expect(snapshot.modelSelectionFailure).toBe(true);
  });

  it("clears the old account's model and waits for the moved scope's own read", async () => {
    fixture.catalogs = {
      'org-a': [{ id: 'a1', name: 'A1', variants: [] }],
      'org-b': [{ id: 'b1', name: 'B1', variants: [] }],
    };
    const held = Promise.withResolvers<Preference>();
    fixture.heldReads['org-b'] = held.promise;
    seedPreference({ organizationId: 'org-a' }, { favorites: [], lastSelected: { model: 'a1' } });
    act(() => {
      renderProvider('org-a');
    });
    expect(snapshot.model).toBe('a1');

    act(() => {
      renderProvider('org-b');
    });
    await settle(
      () =>
        client.getQueryState(preferenceKey({ organizationId: 'org-b' }))?.fetchStatus === 'fetching'
    );
    // The moved scope answers from its own read, not the previous account's
    // entry, and nothing has resolved yet: the form is cleared and waiting
    // instead of holding a model or reporting a selection failure.
    expect(client.getQueryState(preferenceKey({ organizationId: 'org-b' }))?.fetchStatus).toBe(
      'fetching'
    );
    expect(snapshot.model).toBe('');
    expect(snapshot.modelSelectionFailure).toBe(false);

    act(() => {
      held.resolve({ favorites: [], lastSelected: { model: 'b1' } });
    });
    await settle(() => snapshot.model === 'b1');
    expect(snapshot.model).toBe('b1');
  });
});
