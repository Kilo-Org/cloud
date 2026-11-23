import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoSelectModel } from './use-auto-select-model';
import { useModelPreferences } from './use-model-preferences';
import { act, TestRenderer } from '@/test/renderer';

const fixture = vi.hoisted(() => {
  const stored: Record<string, { model: string; variant: string }> = {};
  return {
    stored,
    hasLoaded: true,
    // The organization-default read's answer. Each case sets the phase it needs
    // and `refetch` swaps in what the read answers on the retry.
    orgDefault: {
      defaultModel: undefined as string | undefined,
      isPending: false,
      isError: false,
      isFetching: false,
    },
    refetch: () => undefined,
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
  useOrgDefaultModel: () => ({
    ...fixture.orgDefault,
    refetch: () => {
      fixture.refetch();
    },
  }),
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
let resultKind = 'waiting';
let choose: () => void = () => {
  throw new Error('Form not mounted');
};
let retryOrgDefault: () => void = () => {
  throw new Error('Form not mounted');
};
function Form() {
  const [, bump] = useState(0);
  const autoSelected = useAutoSelectModel(models, undefined);
  resultKind = autoSelected.kind;
  selected =
    autoSelected.kind === 'selected'
      ? { model: autoSelected.model, variant: autoSelected.variant }
      : { model: '', variant: '' };
  if (autoSelected.kind === 'org-default-failed') {
    retryOrgDefault = autoSelected.onRetry;
  }
  const { setLastSelected } = useModelPreferences(undefined);
  choose = () => {
    fixture.stored = { personal: { model: 'chosen', variant: 'high' } };
    setLastSelected({ model: 'chosen', variant: 'high' });
  };
  // The mocked read answers from the fixture, so the retry's own swap has to
  // re-render this form the way the real query's state change would.
  fixture.refetch = () => {
    fixture.orgDefault = {
      defaultModel: 'chosen',
      isPending: false,
      isError: false,
      isFetching: false,
    };
    bump(count => count + 1);
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
  fixture.orgDefault = {
    defaultModel: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
  };
  selected = { model: '', variant: '' };
  resultKind = 'waiting';
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
      lastSelected: { model: string; variant?: string };
    }>();
    fixture.read = () => pendingRead.promise;
    const pendingSave = Promise.withResolvers<undefined>();
    fixture.save = () => pendingSave.promise;
    act(() => {
      renderForm('cold');
    });
    expect(selected).toEqual({ model: '', variant: '' });

    await act(() => {
      choose();
      return Promise.resolve();
    });
    act(() => {
      renderForm('cold-reopened');
    });
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

  it('selects nothing while the organization default is still being read', () => {
    fixture.orgDefault = {
      defaultModel: undefined,
      isPending: true,
      isError: false,
      isFetching: true,
    };
    client.setQueryData(queryKey, { favorites: [], lastSelected: null });
    act(() => {
      renderForm('org-default-pending');
    });
    expect(resultKind).toBe('waiting');
    expect(selected).toEqual({ model: '', variant: '' });
  });

  it('reports a failed organization-default read instead of committing the first catalog row', () => {
    fixture.orgDefault = {
      defaultModel: undefined,
      isPending: false,
      isError: true,
      isFetching: false,
    };
    client.setQueryData(queryKey, { favorites: [], lastSelected: null });
    act(() => {
      renderForm('org-default-failed');
    });
    expect(resultKind).toBe('org-default-failed');
    expect(selected).toEqual({ model: '', variant: '' });

    // Nothing was committed, so a later render has no choice to keep: the
    // first catalog row is never written into the mount's selection.
    act(() => {
      renderForm('org-default-failed');
    });
    expect(selected).toEqual({ model: '', variant: '' });
  });

  it('applies the organization default once the retried read answers', () => {
    fixture.orgDefault = {
      defaultModel: undefined,
      isPending: false,
      isError: true,
      isFetching: false,
    };
    client.setQueryData(queryKey, { favorites: [], lastSelected: null });
    act(() => {
      renderForm('org-default-retry');
    });
    expect(resultKind).toBe('org-default-failed');

    act(() => {
      retryOrgDefault();
    });
    expect(resultKind).toBe('selected');
    expect(selected).toEqual({ model: 'chosen', variant: 'high' });
  });
});
