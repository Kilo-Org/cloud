/* eslint-disable require-await, @typescript-eslint/require-await -- the fake chainSave factories settle without await because they resolve immediately */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as React from 'react';

import { useModelPreferences } from './use-model-preferences';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onMutate?: (vars: unknown) => Promise<unknown> | unknown;
  onError?: (error: unknown, vars: unknown, context: unknown) => void;
  onSuccess?: (result: unknown, vars: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
  scope?: { id: string };
};

// useModelPreferences registers its mutations in this order:
// setLastSelected, clearLastSelected, addFavorite, removeFavorite, setFavorites.
const capturedMutations: (MutationOptions | null)[] = [];
const invalidateQueriesMock = vi.fn();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const cancelQueriesMock = vi.fn();
const toastErrorMock = vi.fn();
const setFavoritesErrorMock = vi.hoisted(() => vi.fn());
const chainSaveMock = vi.hoisted(() =>
  vi.fn(async (_key: string, op: () => Promise<unknown>) => op())
);

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [initial, setFavoritesErrorMock] as const),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useMemo: vi.fn(<T>(fn: () => T) => fn()),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    capturedMutations.push(opts);
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQuery: () => ({ data: { favorites: [], lastSelected: null }, isLoading: false }),
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
    getQueryData: (...args: unknown[]) => getQueryDataMock(...args),
    setQueryData: (...args: unknown[]) => setQueryDataMock(...args),
    cancelQueries: (...args: unknown[]) => cancelQueriesMock(...args),
  }),
  hashKey: (key: unknown) => JSON.stringify(key),
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

vi.mock('@/lib/hooks/save-chain', () => ({
  chainSave: async (key: string, op: () => Promise<unknown>) => chainSaveMock(key, op),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    modelPreferences: {
      get: {
        queryOptions: () => ({ queryKey: ['modelPreferences', 'get'], queryFn: () => undefined }),
        queryKey: (input: unknown) => ['modelPreferences', 'get', input],
      },
      setLastSelected: { mutationOptions: (opts: MutationOptions) => opts },
      clearLastSelected: { mutationOptions: (opts: MutationOptions) => opts },
      setFavorites: { mutationOptions: (opts: MutationOptions) => opts },
    },
  }),
  trpcClient: {
    modelPreferences: {
      addFavorite: { mutate: vi.fn() },
      removeFavorite: { mutate: vi.fn() },
    },
  },
}));

describe('useModelPreferences (generation guard)', () => {
  beforeEach(() => {
    capturedMutations.length = 0;
    invalidateQueriesMock.mockReset();
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
    setFavoritesErrorMock.mockReset();
    chainSaveMock.mockClear();
    chainSaveMock.mockImplementation(async (_key, op) => op());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('serializes favorite mutations through chainSave (rule 1) and adds no scope', async () => {
    useModelPreferences(undefined);
    const addFavorite = capturedMutations[2];
    const removeFavorite = capturedMutations[3];

    await addFavorite?.mutationFn?.({ model: 'm1' });
    expect(chainSaveMock).toHaveBeenCalledWith('model-preferences-favorites', expect.any(Function));
    expect(addFavorite?.scope).toBeUndefined();
    expect(removeFavorite?.scope).toBeUndefined();
  });

  it('a failing older addFavorite does not roll back while a newer one owns the cache', async () => {
    getQueryDataMock.mockReturnValue({ favorites: [], lastSelected: null });
    useModelPreferences(undefined);
    const addFavorite = capturedMutations[2];
    const older = await addFavorite?.onMutate?.({ model: 'm1' });
    const newer = await addFavorite?.onMutate?.({ model: 'm2' });

    setQueryDataMock.mockClear();
    addFavorite?.onError?.(new Error('boom'), { model: 'm1' }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    addFavorite?.onError?.(new Error('boom'), { model: 'm2' }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    // Favorites surface the error inline (no toast).
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(setFavoritesErrorMock).toHaveBeenCalledWith('boom');
  });

  it('a failing latest removeFavorite rolls back its snapshot', async () => {
    getQueryDataMock.mockReturnValue({ favorites: ['m1'], lastSelected: null });
    useModelPreferences(undefined);
    const removeFavorite = capturedMutations[3];
    const context = await removeFavorite?.onMutate?.({ model: 'm1' });

    setQueryDataMock.mockClear();
    removeFavorite?.onError?.(new Error('boom'), { model: 'm1' }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(setFavoritesErrorMock).toHaveBeenCalledWith('boom');
  });

  it('surfaces the inline error even when the stale generation skips the rollback', async () => {
    getQueryDataMock.mockReturnValue({ favorites: [], lastSelected: null });
    useModelPreferences(undefined);
    const addFavorite = capturedMutations[2];
    const older = await addFavorite?.onMutate?.({ model: 'm1' });
    await addFavorite?.onMutate?.({ model: 'm2' });

    setQueryDataMock.mockClear();
    setFavoritesErrorMock.mockClear();
    addFavorite?.onError?.(new Error('boom'), { model: 'm1' }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();
    expect(setFavoritesErrorMock).toHaveBeenCalledWith('boom');
  });
});
