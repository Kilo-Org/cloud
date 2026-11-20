import { act, createElement, type RefObject } from 'react';
import { type ViewInstance } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SheetHeaderTopInset } from '@/lib/form-sheet';
import { renderWithProviders } from '@/test/render-with-providers';

import {
  type PresentedSheetTopClearance,
  usePresentedSheetTopClearance,
} from './use-presented-sheet-top-inset';

type Read = PresentedSheetTopClearance;

const native = vi.hoisted(() => ({
  available: true,
  platform: 'ios' as string,
  insetTop: 20,
  /** The origin every read answers once the queue below is empty. */
  origin: null as number | null,
  /** Origins the next reads answer, in order; each shifts one off. */
  queued: [] as (number | null)[],
  failing: false,
  read: vi.fn<(tag: number) => void>(),
  find: vi.fn<(node: ViewInstance) => number | undefined>(),
}));

vi.mock('react-native', () => ({
  findNodeHandle: native.find,
  Platform: {
    get OS() {
      return native.platform;
    },
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: native.insetTop, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/lib/native-surface-geometry', () => ({
  get isNativeSurfaceGeometryAvailable() {
    return native.available;
  },
  presentedSurfaceOriginTop: (tag: number) => {
    native.read(tag);
    if (native.failing) {
      return Promise.reject(new Error('The native surface view is not mounted.'));
    }
    const queued = native.queued.shift();
    return Promise.resolve(queued === undefined ? native.origin : queued);
  },
}));

const surface: Partial<ViewInstance> = {};
const surfaceRef: RefObject<ViewInstance | null> = { current: surface as ViewInstance };

async function mount(input: {
  topInset?: SheetHeaderTopInset | undefined;
  clearance?: number;
}): Promise<{ read: () => Read; unmount: () => void }> {
  let latest: Read | undefined = undefined;
  function Probe() {
    latest = usePresentedSheetTopClearance({
      topInset: 'topInset' in input ? input.topInset : 'bottom-form-sheet',
      clearance: input.clearance ?? 0,
      surfaceRef,
    });
    return null;
  }
  const mounted = await renderWithProviders(createElement(Probe));
  return {
    read: () => {
      if (!latest) {
        throw new Error('hook did not render');
      }
      return latest;
    },
    unmount: mounted.unmount,
  };
}

/** Runs every sample of a presentation burst and lets its reads settle. */
async function settleBurst(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1400);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Runs only the samples owed to the burst's first timer. */
async function settleFirstSample(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  native.available = true;
  native.platform = 'ios';
  native.insetTop = 20;
  native.origin = null;
  native.queued = [];
  native.failing = false;
  native.find.mockReturnValue(41);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePresentedSheetTopClearance', () => {
  it('covers the status-bar band on a phone whose sheet presents at the window top', async () => {
    // The short phone: iOS's maximum sheet height is the window, so the native
    // origin converts to 0 and the whole 20pt band is above the first row.
    native.origin = 0;
    const mounted = await mount({ clearance: 0 });
    await settleBurst();

    expect(mounted.read().clearance).toBe(20);
    mounted.unmount();
  });

  it('keeps a standard phone unchanged, where the sheet presented below the inset', async () => {
    native.insetTop = 62;
    native.origin = 62;
    const mounted = await mount({ clearance: 0 });
    await settleBurst();

    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });

  it('reads the header view it was handed, once per sample burst', async () => {
    native.origin = 62;
    const mounted = await mount({ clearance: 0 });
    await settleBurst();

    expect(native.find).toHaveBeenCalledWith(surface);
    expect(native.read).toHaveBeenCalled();
    expect(native.read.mock.calls.every(([tag]) => tag === 41)).toBe(true);
    mounted.unmount();
  });

  it('follows the sheet when it moves again after the presentation', async () => {
    native.origin = 62;
    const mounted = await mount({ clearance: 0 });
    await settleBurst();
    expect(mounted.read().clearance).toBe(0);

    // The keyboard expands the sheet to the full detent, which puts its edge at
    // the window top: the header now covers the band.
    native.origin = 0;
    await act(async () => {
      mounted.read().onLayout();
      await Promise.resolve();
    });
    await settleBurst();

    expect(mounted.read().clearance).toBe(20);
    mounted.unmount();
  });

  it('keeps the clearance its surface mode already reserved when that is larger', async () => {
    native.origin = 0;
    const mounted = await mount({ clearance: 51.81 });
    await settleBurst();

    expect(mounted.read().clearance).toBe(51.81);
    mounted.unmount();
  });

  it('adds nothing where the native read answers no origin', async () => {
    native.origin = null;
    const mounted = await mount({ clearance: 0 });
    await settleBurst();

    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });

  it('adds nothing where the binary has no native geometry module', async () => {
    native.available = false;
    const mounted = await mount({ clearance: 0 });
    await settleBurst();

    expect(native.read).not.toHaveBeenCalled();
    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });

  it('adds nothing on Android, whose settled read owns that platform', async () => {
    native.platform = 'android';
    native.origin = 0;
    const mounted = await mount({ clearance: 0 });
    await settleBurst();

    expect(native.read).not.toHaveBeenCalled();
    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });

  it('adds nothing for a surface mode that cannot reach the window top', async () => {
    native.origin = 0;
    const mounted = await mount({ topInset: 'never', clearance: 0 });
    await settleBurst();

    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });

  it('adds nothing for a header with no surface mode', async () => {
    native.origin = 0;
    const mounted = await mount({ topInset: undefined, clearance: 0 });
    await settleBurst();

    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });

  it('keeps its clearance when a read fails instead of taking the header down', async () => {
    native.failing = true;
    const mounted = await mount({ clearance: 4 });
    await settleBurst();

    expect(mounted.read().clearance).toBe(4);
    mounted.unmount();
  });

  it('publishes nothing from a burst the sheet has already replaced', async () => {
    // A sample still in flight when the header lays out again belongs to the
    // presentation before that layout; its answer must not land on the new one.
    // The first burst is queued to answer the window top and the second the
    // settled standard-phone edge.
    native.queued = [0, 62, 62, 62, 62, 62, 62];
    const mounted = await mount({ clearance: 0 });
    await settleFirstSample();

    await act(async () => {
      mounted.read().onLayout();
      await Promise.resolve();
    });
    await settleBurst();

    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });

  it('stops reading after the header unmounts', async () => {
    native.origin = 0;
    const mounted = await mount({ clearance: 0 });
    mounted.unmount();
    native.read.mockClear();
    await settleBurst();

    expect(native.read).not.toHaveBeenCalled();
  });

  it('does nothing where the runtime cannot find a view tag', async () => {
    native.find.mockReturnValue(undefined);
    const mounted = await mount({ clearance: 0 });
    await settleBurst();

    expect(native.read).not.toHaveBeenCalled();
    expect(mounted.read().clearance).toBe(0);
    mounted.unmount();
  });
});
