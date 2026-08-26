import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

// eslint-disable-next-line no-empty-function -- listener body is irrelevant, only subscribe()'s side effect (starting the load) is under test
function noopListener(): void {}

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function makeStore() {
  // Re-import lazily so the mock wiring above is in effect.
  return import('./secure-store-preference').then(({ createSecureStorePreference }) =>
    createSecureStorePreference<boolean>({
      key: 'pr-review-footer-enabled',
      defaultValue: true,
      parse: raw => raw !== 'false',
      serialize: value => (value ? 'true' : 'false'),
    })
  );
}

describe('parsePrReviewFooter', () => {
  it('defaults to on for a missing value (fresh install and unreadable read)', async () => {
    const { parsePrReviewFooter } = await import('./use-pr-review-footer-preference');
    expect(parsePrReviewFooter(null)).toBe(true);
  });

  it("reads 'true' as on", async () => {
    const { parsePrReviewFooter } = await import('./use-pr-review-footer-preference');
    expect(parsePrReviewFooter('true')).toBe(true);
  });

  it("reads 'false' as off — the only value that turns the preference off", async () => {
    const { parsePrReviewFooter } = await import('./use-pr-review-footer-preference');
    expect(parsePrReviewFooter('false')).toBe(false);
  });

  it('treats any other stored string as on', async () => {
    const { parsePrReviewFooter } = await import('./use-pr-review-footer-preference');
    expect(parsePrReviewFooter('')).toBe(true);
    expect(parsePrReviewFooter('nonsense')).toBe(true);
  });
});

describe('pr-review-footer store', () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
  });

  it('defaults to on when SecureStore returns null', async () => {
    getItemAsync.mockResolvedValue(null);
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(true);
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it("turns off only for the stored string 'false'", async () => {
    getItemAsync.mockResolvedValue('false');
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(false);
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it('persists a set value and clears back to the default on sign-out', async () => {
    getItemAsync.mockResolvedValue(null);
    const store = await makeStore();

    store.set(false);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('pr-review-footer-enabled', 'false');

    store.set(true);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('pr-review-footer-enabled', 'true');

    store.clear();
    await flushMicrotasks();
    expect(deleteItemAsync).toHaveBeenCalledWith('pr-review-footer-enabled');
    expect(store.get()).toBe(true);
  });
});
