import { act, createElement, useState } from 'react';
import { type View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type NativeSurfaceGeometry } from '@/lib/native-surface-geometry';
import { renderWithProviders } from '@/test/render-with-providers';

import { useNativeStateGeometry } from './use-native-state-geometry';

type Deferred = {
  resolve: (geometry: NativeSurfaceGeometry) => void;
  reject: (error: Error) => void;
};

const native = vi.hoisted(() => {
  const pending = new Map<number, Deferred>();
  const listeners = new Set<(geometry: NativeSurfaceGeometry) => void>();
  return {
    available: true,
    pending,
    listeners,
    find: vi.fn<(node: View) => number | null>(),
    observe: vi.fn(async (tag: number) => {
      const result = await new Promise<NativeSurfaceGeometry>((resolve, reject) => {
        pending.set(tag, { resolve, reject });
      });
      return result;
    }),
    unobserve: vi.fn(async (_tag: number) => {
      await Promise.resolve();
    }),
  };
});

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('react-native', () => ({ findNodeHandle: native.find }));
vi.mock('@/lib/native-surface-geometry', () => ({
  get isNativeSurfaceGeometryAvailable() {
    return native.available;
  },
  addSurfaceGeometryListener: (listener: (geometry: NativeSurfaceGeometry) => void) => {
    native.listeners.add(listener);
    return { remove: () => native.listeners.delete(listener) };
  },
  observeSurface: native.observe,
  unobserveSurface: native.unobserve,
}));

const firstMock: Partial<View> = {};
const secondMock: Partial<View> = {};
const first = firstMock as View;
const second = secondMock as View;
const snapshot = (tag = 41): NativeSurfaceGeometry => ({
  tag,
  visibleTop: 0,
  visibleBottom: 800,
  boundsHeight: 800,
  safeAreaTop: 20,
  safeAreaBottom: 34,
  keyboardOverlap: 0,
});

async function mount() {
  let observation: ReturnType<typeof useNativeStateGeometry> | undefined = undefined;
  let update: ((node: View) => void) | undefined = undefined;
  function Probe() {
    const [node, setNode] = useState(first);
    update = setNode;
    observation = useNativeStateGeometry(node);
    return null;
  }
  const mounted = await renderWithProviders(createElement(Probe));
  return {
    ...mounted,
    read: () => observation,
    update: (node: View) => {
      act(() => {
        update?.(node);
      });
    },
    resolve: async (tag: number, geometry = snapshot(tag)) => {
      await act(async () => {
        native.pending.get(tag)?.resolve(geometry);
        await Promise.resolve();
      });
    },
    emit: (geometry: NativeSurfaceGeometry) => {
      act(() => {
        for (const listener of native.listeners) {
          listener(geometry);
        }
      });
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (onFrame: FrameRequestCallback) => {
    onFrame(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.clearAllMocks();
  native.available = true;
  native.pending.clear();
  native.listeners.clear();
  native.find.mockImplementation(node => (node === first ? 41 : 42));
});

afterEach(() => vi.unstubAllGlobals());

describe('useNativeStateGeometry', () => {
  it('waits for the native mounting frame before observing', async () => {
    let frame: FrameRequestCallback | undefined = undefined;
    vi.stubGlobal('requestAnimationFrame', (onFrame: FrameRequestCallback) => {
      frame = onFrame;
      return 7;
    });
    const mounted = await mount();
    expect(native.observe).not.toHaveBeenCalled();
    act(() => {
      frame?.(0);
    });
    expect(native.observe).toHaveBeenCalledWith(41);
    await mounted.resolve(41);
    expect(mounted.read()?.status).toBe('ready');
    mounted.unmount();
  });

  it('cancels observation when the state disappears before its mounting frame', async () => {
    let frame: FrameRequestCallback | undefined = undefined;
    vi.stubGlobal('requestAnimationFrame', (onFrame: FrameRequestCallback) => {
      frame = onFrame;
      return 8;
    });
    const mounted = await mount();
    mounted.unmount();
    act(() => {
      frame?.(0);
    });
    expect(cancelAnimationFrame).toHaveBeenCalledWith(8);
    expect(native.observe).not.toHaveBeenCalled();
  });

  it('reports an old client without pretending native measurements exist', async () => {
    native.available = false;
    const mounted = await mount();
    expect(mounted.read()).toMatchObject({ status: 'unavailable', geometry: null });
    expect(native.find).not.toHaveBeenCalled();
    expect(native.observe).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('accepts its initial snapshot and ignores other native roots', async () => {
    const mounted = await mount();
    expect(mounted.read()?.status).toBe('pending');
    await mounted.resolve(41);
    expect(mounted.read()).toMatchObject({ status: 'ready', geometry: snapshot() });
    const previous = mounted.read();
    mounted.emit(snapshot(42));
    expect(mounted.read()).toBe(previous);
    mounted.emit(snapshot());
    expect(mounted.read()).toBe(previous);
    mounted.unmount();
  });

  it('ignores an old snapshot after the root changes', async () => {
    const mounted = await mount();
    mounted.update(second);
    await mounted.resolve(41);
    expect(mounted.read()).toMatchObject({ status: 'pending', geometry: null });
    await mounted.resolve(42);
    expect(mounted.read()).toMatchObject({ status: 'ready', geometry: snapshot(42) });
    expect(native.unobserve).toHaveBeenCalledWith(41);
    mounted.unmount();
  });

  it('removes the listener and observer before a late snapshot resolves', async () => {
    const mounted = await mount();
    mounted.unmount();
    expect(native.listeners.size).toBe(0);
    expect(native.unobserve).toHaveBeenCalledWith(41);
    await mounted.resolve(41);
    expect(mounted.read()?.status).toBe('pending');
  });

  it('exposes observation failure instead of marking it native-ready', async () => {
    const mounted = await mount();
    await act(async () => {
      native.pending.get(41)?.reject(new Error('View unavailable'));
      await Promise.resolve();
    });
    expect(mounted.read()).toMatchObject({ status: 'failed', geometry: null });
    mounted.unmount();
  });

  it('accepts detachment and reattachment without replacing the React ref', async () => {
    const mounted = await mount();
    await mounted.resolve(41);
    mounted.emit({ ...snapshot(), visibleBottom: 0 });
    expect(mounted.read()?.geometry?.visibleBottom).toBe(0);
    mounted.emit({ ...snapshot(), visibleBottom: 500, keyboardOverlap: 300 });
    expect(mounted.read()?.geometry?.visibleBottom).toBe(500);
    expect(native.observe).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('rejects non-finite native bounds', async () => {
    const mounted = await mount();
    await mounted.resolve(41, { ...snapshot(), visibleBottom: Number.NaN });
    expect(mounted.read()).toMatchObject({ status: 'failed', geometry: null });
    mounted.unmount();
  });
});
