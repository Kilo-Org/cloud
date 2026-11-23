import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewSessionModelProvider, useNewSessionModelState } from './new-session-model-provider';
import { act, TestRenderer } from '@/test/renderer';

const fixture = vi.hoisted(() => {
  // The catalog each account scope answers with, keyed by scope (`personal`
  // stands in for the organization-less account).
  const catalogs: Record<string, { id: string; name: string; variants: string[] }[]> = {};
  // The organization-default read's phase per scope, so a moved scope can
  // answer with its own failure.
  const orgDefaults: Record<
    string,
    { defaultModel?: string; isPending: boolean; isError: boolean; isFetching: boolean }
  > = {};
  const prefill: { mode: string } = { mode: 'code' };
  const read = () =>
    Promise.resolve({
      favorites: [] as string[],
      lastSelected: null as { model: string; variant?: string } | null,
    });
  return { catalogs, orgDefaults, prefill, read };
});

const queryKey = [['modelPreferences', 'get'], { type: 'query' }] as const;

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
        queryOptions: () => ({
          queryKey,
          queryFn: () => fixture.read(),
          staleTime: Infinity,
        }),
        queryKey: () => queryKey,
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', false);
  fixture.catalogs = {};
  fixture.orgDefaults = {};
  fixture.prefill = { mode: 'code' };
  fixture.read = () =>
    Promise.resolve({
      favorites: [],
      lastSelected: null as { model: string; variant?: string } | null,
    });
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
  it('resolves the model from the account the form shows after the scope moves', () => {
    fixture.catalogs = {
      'org-a': [{ id: 'a1', name: 'A1', variants: [] }],
      'org-b': [{ id: 'b1', name: 'B1', variants: [] }],
    };
    client.setQueryData(queryKey, { favorites: [], lastSelected: { model: 'a1' } });
    act(() => {
      renderProvider('org-a');
    });
    expect(snapshot.model).toBe('a1');

    act(() => {
      renderProvider('org-b');
    });
    expect(snapshot.model).toBe('b1');
  });

  it('keeps the explicit pick while the account scope is unchanged', () => {
    fixture.catalogs = { 'org-a': [{ id: 'a1', name: 'A1', variants: [] }] };
    client.setQueryData(queryKey, { favorites: [], lastSelected: { model: 'a1' } });
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

  it("reports the moved scope's model-selection failure", () => {
    fixture.catalogs = {
      'org-a': [{ id: 'a1', name: 'A1', variants: [] }],
      'org-b': [{ id: 'b1', name: 'B1', variants: [] }],
    };
    fixture.orgDefaults = {
      'org-b': { defaultModel: undefined, isPending: false, isError: true, isFetching: false },
    };
    client.setQueryData(queryKey, { favorites: [], lastSelected: { model: 'a1' } });
    act(() => {
      renderProvider('org-a');
    });
    expect(snapshot.model).toBe('a1');

    act(() => {
      renderProvider('org-b');
    });
    expect(snapshot.model).toBe('');
    expect(snapshot.modelSelectionFailure).toBe(true);
  });
});
