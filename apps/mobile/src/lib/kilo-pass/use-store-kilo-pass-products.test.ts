import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type StoreKiloPassProduct } from './store-products';
import { useStoreKiloPassProducts } from './use-store-kilo-pass-products';

// ── Mutable query state ──────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    dataUpdatedAt: 0,
    error: null as unknown,
    isError: false,
    isLoading: false,
    isRefetching: false,
    isSuccess: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => mocks.query,
  useQueryClient: () => ({ fetchQuery: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ kiloPass: { getMobileStoreProducts: { queryOptions: () => ({}) } } }),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

// ── Harness ──────────────────────────────────────────────────────────

type HookValue = ReturnType<typeof useStoreKiloPassProducts>;

let latest: HookValue | null = null;

// The mocked query never runs its queryFn, so the store fetch is never called.
const fetchStoreProducts =
  vi.fn<(productSkus: string[]) => Promise<readonly StoreKiloPassProduct[]>>();

function Probe({ connected }: { connected: boolean }) {
  latest = useStoreKiloPassProducts({ connected, fetchStoreProducts });
  return null;
}

function current(): HookValue {
  if (!latest) {
    throw new Error('Probe has not rendered');
  }
  return latest;
}

function ignoreDeferredResolution(_value: unknown): void {
  return undefined;
}

function createDeferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolvePromise: (value: unknown) => void = ignoreDeferredResolution;
  const promise = new Promise<unknown>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function renderProbe(connected: boolean): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe, { connected }));
    await Promise.resolve();
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

// The retry is not awaited: the test steps the clock while it is still running.
async function startRetry(): Promise<void> {
  await act(() => {
    void current().refetch();
  });
}

// The store connection drops and comes back through the `connected` prop, the
// only input the hook reads from the IAP owner.
async function setConnected(
  renderer: TestRenderer.ReactTestRenderer,
  connected: boolean
): Promise<void> {
  await act(async () => {
    renderer.update(createElement(Probe, { connected }));
    await Promise.resolve();
  });
}

const PLAY_CONNECTION_MESSAGE = i18n.t('kiloPass.couldNotConnectToPlay');

// A catalog entry as the store fetch returns it. The product state passes the
// fetched array through untouched, so assertions compare the same reference.
const loadedProduct = { appleProductId: 'com.kilo.pass.tier19.monthly' };

describe('useStoreKiloPassProducts retry busy state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.query.data = undefined;
    mocks.query.dataUpdatedAt = 0;
    mocks.query.error = null;
    mocks.query.isError = false;
    mocks.query.isLoading = false;
    mocks.query.isRefetching = false;
    mocks.query.isSuccess = false;
    mocks.query.refetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the store error on screen and stays busy for the whole bounded wait while the store is unreachable', async () => {
    // A disabled query settles without fetching: on a device with no store the
    // retry waits on the bounded connection handshake, not on the catalog fetch.
    mocks.query.refetch.mockResolvedValue({ status: 'error' });
    const renderer = await renderProbe(false);

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(current().isLoading).toBe(false);
    expect(current().errorMessage).toBe(PLAY_CONNECTION_MESSAGE);

    await startRetry();

    // The busy state replaces the settled card without unmounting it: the card's
    // error and its products list are the same before, during, and after.
    expect(current().isRefetching).toBe(true);
    expect(current().isLoading).toBe(false);
    expect(current().errorMessage).toBe(PLAY_CONNECTION_MESSAGE);

    // Past the minimum busy time the handshake is still running, so the busy
    // state must survive the floor.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(current().isRefetching).toBe(true);

    // The bounded wait ends, and the one unchanged error is still the card's.
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(current().isRefetching).toBe(false);
    expect(current().errorMessage).toBe(PLAY_CONNECTION_MESSAGE);

    renderer.unmount();
  });

  it('stays busy until the slow catalog fetch settles, past the minimum busy time', async () => {
    const deferred = createDeferred();
    mocks.query.refetch.mockReturnValue(deferred.promise);
    const renderer = await renderProbe(true);

    await startRetry();
    expect(current().isRefetching).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(current().isRefetching).toBe(true);

    await act(async () => {
      deferred.resolve({ status: 'success' });
      await Promise.resolve();
    });
    expect(current().isRefetching).toBe(false);

    renderer.unmount();
  });

  it('shows the busy state for at least the minimum time when the store answers instantly', async () => {
    mocks.query.refetch.mockResolvedValue({ status: 'error' });
    const renderer = await renderProbe(true);

    await startRetry();
    expect(current().isRefetching).toBe(true);

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(current().isRefetching).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(current().isRefetching).toBe(false);

    renderer.unmount();
  });

  it('clears the stale store-connection error once a retry loads the catalog again', async () => {
    // The catalog loaded once, so React Query keeps the status at success while
    // the query is disabled. The clearing effect therefore has to react to the
    // fetch that succeeds, not only to the first success, or a reconnected store
    // can never take the products-unavailable card away.
    mocks.query.isSuccess = true;
    mocks.query.data = [loadedProduct];
    mocks.query.dataUpdatedAt = 1;
    const renderer = await renderProbe(true);

    await setConnected(renderer, false);
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(current().errorMessage).toBe(PLAY_CONNECTION_MESSAGE);
    expect(current().products).toEqual([]);

    // The store is back and the user taps retry: the fetch answers, so the
    // message from the drop no longer describes this screen.
    mocks.query.refetch.mockImplementation(async () => {
      await Promise.resolve();
      mocks.query.dataUpdatedAt = 2;
      return { status: 'success' };
    });
    await setConnected(renderer, true);
    await startRetry();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(current().errorMessage).toBeNull();
    expect(current().products).toEqual([loadedProduct]);

    renderer.unmount();
  });

  it('holds the card, not the skeletons, when a retry starts while the catalog is loading', async () => {
    // The store is connected and the catalog has not answered yet. The retry
    // term in `isLoading` is what keeps the products-unavailable card (and its
    // busy button) mounted instead of flashing the loading skeletons back.
    mocks.query.isLoading = true;
    mocks.query.refetch.mockReturnValue(createDeferred().promise);
    const renderer = await renderProbe(true);

    expect(current().isLoading).toBe(true);

    await startRetry();

    expect(current().isLoading).toBe(false);
    expect(current().isRefetching).toBe(true);

    renderer.unmount();
  });
});
