import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoSelectModel } from './use-auto-select-model';
import { useModelPreferences } from './use-model-preferences';
import { act, TestRenderer } from '@/test/renderer';

const fixture = vi.hoisted(() => {
  const stored: Record<string, { model: string; variant: string }> = {};
  return {
    stored,
    hasLoaded: true,
    save: (_input: { model: string; variant?: string }) => Promise.resolve(),
  read: () => Promise.resolve({ favorites: ['first'], lastSelected: { model: 'first' } }),
  };
});
const queryKey = [['modelPreferences', 'get'], { type: 'query' }] as const;
const models = [
  { id: 'first', name: 'First', variants: [], isPreferred: false },
  { id: 'chosen', name: 'Chosen', variants: ['high'], isPreferred: false },
];

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

vi.mock('@/lib/hooks/use-available-models', () => ({
  useOrgDefaultModel: () => ({ defaultModel: undefined, isLoading: false }),
}));
vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  usePersistedAgentModel: () => ({ stored: fixture.stored, hasLoaded: fixture.hasLoaded }),
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
      setLastSelected: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: (input: { model: string; variant?: string }) => fixture.save(input),
        }),
      },
      clearLastSelected: { mutationOptions: (options: object) => options },
      setFavorites: { mutationOptions: (options: object) => options },
    },
  }),
  trpcClient: {
    modelPreferences: {
      setLastSelected: {
        mutate: (input: { model: string; variant?: string }) => fixture.save(input),
      },
    },
  },
}));

let selected = { model: '', variant: '' };
let choose: () => void = () => {
  throw new Error('Form not mounted');
};
function Form() {
  selected = useAutoSelectModel(models, undefined);
  const { setLastSelected } = useModelPreferences(undefined);
  choose = () => {
    fixture.stored = { personal: { model: 'chosen', variant: 'high' } };
    setLastSelected({ model: 'chosen', variant: 'high' });
  };
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let client = new QueryClient();
function renderForm(key: string) {
  const tree = (
    <QueryClientProvider client={client}>
      <Form key={key} />
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
  fixture.stored = {};
  fixture.hasLoaded = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  client.clear();
  vi.unstubAllGlobals();
});

describe('new-session preference resolution', () => {
  it('keeps the explicit model and effort when reopened before the server save finishes', async () => {
    client.setQueryData(queryKey, { favorites: ['first'], lastSelected: { model: 'first' } });
    act(() => {
      renderForm('initial');
    });
    const pendingSave = Promise.withResolvers<undefined>();
    fixture.save = () => pendingSave.promise;
    await act(() => {
      choose();
      return Promise.resolve();
    });
    act(() => {
      renderForm('reopened');
    });
    expect(selected).toEqual({ model: 'chosen', variant: 'high' });
    expect(client.getQueryData(queryKey)).toEqual({
      favorites: ['first'],
      lastSelected: { model: 'chosen', variant: 'high' },
    });
    await act(() => {
      pendingSave.resolve(undefined);
      return pendingSave.promise;
    });
  });

  it('ignores an older preference read that finishes after an explicit pick', async () => {
    const oldPreference = { favorites: ['first'], lastSelected: { model: 'first' } };
    client.setQueryData(queryKey, oldPreference);
    act(() => {
      renderForm('initial');
    });
    const pendingRead = Promise.withResolvers<typeof oldPreference>();
    const pendingSave = Promise.withResolvers<undefined>();
    fixture.save = () => pendingSave.promise;
    const read = client.fetchQuery({ queryKey, queryFn: () => pendingRead.promise });
    const readOutcome = Promise.allSettled([read]);

    await act(() => {
      choose();
      return Promise.resolve();
    });
    await act(async () => {
      pendingRead.resolve(oldPreference);
      await readOutcome;
    });
    act(() => {
      renderForm('reopened');
    });
    expect(selected).toEqual({ model: 'chosen', variant: 'high' });
    await act(() => {
      pendingSave.resolve(undefined);
      return pendingSave.promise;
    });
  });

  it('publishes the explicit pick before the first preference read settles', async () => {
    const pendingRead = Promise.withResolvers<{
      favorites: string[];
      lastSelected: { model: string };
    }>();
    fixture.read = () => pendingRead.promise;
    const pendingSave = Promise.withResolvers<undefined>();
    fixture.save = () => pendingSave.promise;
    act(() => renderForm('cold'));
    expect(selected).toEqual({ model: '', variant: '' });

    await act(() => {
      choose();
      return Promise.resolve();
    });
    act(() => renderForm('cold-reopened'));
    expect(selected).toEqual({ model: 'chosen', variant: 'high' });
    await act(() => {
      pendingRead.resolve({ favorites: [], lastSelected: { model: 'chosen', variant: 'high' } });
      pendingSave.resolve(undefined);
      return pendingSave.promise;
    });
  });

  it('does not commit a catalog fallback while the stored preference is loading', () => {
    fixture.hasLoaded = false;
    client.setQueryData(queryKey, { favorites: [], lastSelected: null });
    act(() => {
      renderForm('loading');
    });
    expect(selected).toEqual({ model: '', variant: '' });

    fixture.stored = { personal: { model: 'chosen', variant: 'high' } };
    fixture.hasLoaded = true;
    act(() => {
      renderForm('loading');
    });
    expect(selected).toEqual({ model: 'chosen', variant: 'high' });
  });
});
