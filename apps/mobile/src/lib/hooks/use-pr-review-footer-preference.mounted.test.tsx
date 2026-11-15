import { createElement } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { PR_REVIEW_FOOTER_KEY } from '@/lib/storage-keys';

import { type usePrReviewFooterPreference } from './use-pr-review-footer-preference';

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

type PreferenceHook = typeof usePrReviewFooterPreference;

const renderers: TestRenderer.ReactTestRenderer[] = [];

/**
 * Mounting the shipped hook is what starts the store's disk read: nothing else
 * preloads it. The probe prints the value and the load flag, so a case can wait
 * for the read to land instead of guessing at a microtask count.
 */
function Probe({ usePreference }: { usePreference: PreferenceHook }) {
  const { prReviewFooter, hasLoaded } = usePreference();
  return createElement('ProbeText', null, `${String(prReviewFooter)}:${String(hasLoaded)}`);
}

async function renderProbe(usePreference: PreferenceHook): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(Probe, { usePreference }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  return renderer;
}

/** The probe's `value:hasLoaded` text, for example `'false:true'`. */
function probeText(renderer: TestRenderer.ReactTestRenderer): string {
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) {
    throw new Error('probe rendered no text');
  }
  return json.children.filter((child): child is string => typeof child === 'string').join('');
}

/**
 * A read the case settles itself, so the render before the disk read lands can
 * be observed instead of guessed at.
 */
function deferredRead<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

// The store is a module-level singleton that latches its one disk read, so each
// case loads a fresh copy to start cold with the mocks above in effect. A static
// import cannot reset the module registry, so this suite imports at run time.
function loadModule() {
  vi.resetModules();
  return import('./use-pr-review-footer-preference');
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

  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
  });

  it('defaults to on when SecureStore returns null', async () => {
    const read = deferredRead<string | null>();
    getItemAsync.mockReturnValue(read.promise);
    const mod = await loadModule();
    const renderer = await renderProbe(mod.usePrReviewFooterPreference);

    // The shipped default shows before the read settles, and the read uses the
    // shipped key.
    expect(probeText(renderer)).toBe('true:false');
    expect(getItemAsync).toHaveBeenCalledWith(PR_REVIEW_FOOTER_KEY);

    await act(() => {
      read.resolve(null);
    });
    await vi.waitFor(() => {
      expect(probeText(renderer)).toBe('true:true');
    });

    // The settled read keeps the shipped default and writes nothing back.
    expect(mod.getPrReviewFooter()).toBe(true);
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  it("turns off only for the stored string 'false'", async () => {
    const read = deferredRead<string | null>();
    getItemAsync.mockReturnValue(read.promise);
    const mod = await loadModule();
    const renderer = await renderProbe(mod.usePrReviewFooterPreference);

    // The shipped default is on, so off proves the shipped parse ran in the
    // shipped store instead of a default.
    expect(probeText(renderer)).toBe('true:false');

    await act(() => {
      read.resolve('false');
    });
    await vi.waitFor(() => {
      expect(probeText(renderer)).toBe('false:true');
    });
    expect(mod.getPrReviewFooter()).toBe(false);
  });

  it('persists each set value and clears back to the default from off on sign-out', async () => {
    getItemAsync.mockResolvedValue(null);
    const mod = await loadModule();
    const renderer = await renderProbe(mod.usePrReviewFooterPreference);
    await vi.waitFor(() => {
      expect(probeText(renderer)).toBe('true:true');
    });

    await act(() => {
      mod.setPrReviewFooter(false);
    });
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenCalledTimes(1);
    });
    expect(setItemAsync).toHaveBeenLastCalledWith(PR_REVIEW_FOOTER_KEY, 'false');
    expect(mod.getPrReviewFooter()).toBe(false);

    await act(() => {
      mod.setPrReviewFooter(true);
    });
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenCalledTimes(2);
    });
    expect(setItemAsync).toHaveBeenLastCalledWith(PR_REVIEW_FOOTER_KEY, 'true');
    expect(mod.getPrReviewFooter()).toBe(true);

    // Turn it off again so the clear below starts from the opposite of the
    // default: only a clear that resets the value can turn it back on.
    await act(() => {
      mod.setPrReviewFooter(false);
    });
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenCalledTimes(3);
    });
    expect(setItemAsync).toHaveBeenLastCalledWith(PR_REVIEW_FOOTER_KEY, 'false');
    expect(mod.getPrReviewFooter()).toBe(false);

    await act(() => {
      mod.clearPrReviewFooterPreference();
    });
    await vi.waitFor(() => {
      expect(deleteItemAsync).toHaveBeenCalledWith(PR_REVIEW_FOOTER_KEY);
    });
    // A clear that deletes the key but forgets to reset the value stays off.
    expect(mod.getPrReviewFooter()).toBe(true);
    expect(probeText(renderer)).toBe('true:true');
  });
});
