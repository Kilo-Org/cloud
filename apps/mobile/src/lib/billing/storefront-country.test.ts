import { describe, expect, it, vi } from 'vitest';

/** The store's answer per call; `failure` makes the call reject. */
const store = vi.hoisted(() => ({
  answers: [{ country: 'USA' }] as { country: string }[],
  failure: null as Error | null,
  calls: 0,
}));

vi.mock('expo-iap', () => ({
  getStorefront: () => {
    store.calls += 1;
    if (store.failure != null) {
      return Promise.reject(store.failure);
    }
    const next = store.answers.shift();
    if (next == null) {
      return Promise.reject(new Error('no storefront answer queued'));
    }
    return Promise.resolve(next.country);
  },
}));

// The module keeps its cache at module scope, so every case loads a fresh copy.
function load() {
  vi.resetModules();
  return import('@/lib/billing/storefront-country');
}

describe('readStorefrontCountry', () => {
  it('keeps a successful answer for the session and stops asking the store', async () => {
    store.answers = [{ country: 'USA' }];
    store.failure = null;
    store.calls = 0;
    const { readStorefrontCountry } = await load();

    expect(await readStorefrontCountry()).toBe('USA');
    expect(await readStorefrontCountry()).toBe('USA');
    expect(store.calls).toBe(1);
  });

  it('does not keep a failed read, so the next surface asks the store again', async () => {
    store.answers = [{ country: 'DEU' }];
    store.failure = new Error('storefront unavailable');
    store.calls = 0;
    const { readStorefrontCountry } = await load();

    expect(await readStorefrontCountry()).toBeNull();
    store.failure = null;

    expect(await readStorefrontCountry()).toBe('DEU');
    expect(store.calls).toBe(2);
  });

  it('shares one read between surfaces that ask together', async () => {
    store.answers = [{ country: 'USA' }];
    store.failure = null;
    store.calls = 0;
    const { readStorefrontCountry } = await load();

    const [first, second] = await Promise.all([readStorefrontCountry(), readStorefrontCountry()]);
    expect(first).toBe('USA');
    expect(second).toBe('USA');
    expect(store.calls).toBe(1);
  });
});
