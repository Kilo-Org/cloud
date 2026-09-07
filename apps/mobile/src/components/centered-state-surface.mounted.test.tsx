import {
  act,
  type ComponentProps,
  createElement,
  createRef,
  type ReactNode,
  StrictMode,
  useImperativeHandle,
  useState,
} from 'react';
import { type LayoutChangeEvent, type View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { NativeStateSurface, StateSurface, useStateSurface } from './centered-state-surface';

type SurfaceProps = ComponentProps<typeof NativeStateSurface>;
type Options = SurfaceProps['options'];
type NativeProps = NonNullable<Options['unstable_nativeProps']>;
type Measurement = Parameters<View['measureInWindow']>[0];

const geometryHook = vi.hoisted(() => vi.fn(() => ({ status: 'unavailable', geometry: null })));
vi.mock('@/lib/hooks/use-native-state-geometry', () => ({ useNativeStateGeometry: geometryHook }));

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', () => ({
  Platform: platform,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  View: 'View',
}));

function createHarness(initialOptions: Options = {}, strict = false) {
  const measurements: Measurement[] = [];
  const nodeMock: Partial<View> = {
    measureInWindow: vi.fn((onMeasure: Measurement) => {
      measurements.push(onMeasure);
    }),
    scrollTop: 0,
  };
  const node = nodeMock as View;
  const listeners = new Map<string, () => void>();
  let updateOptions: ((options: Options) => void) | undefined = undefined;
  let currentOptions = initialOptions;
  let geometry: ReturnType<typeof useStateSurface> = null;
  const navigation = {
    isFocused: () => true,
    setOptions: vi.fn((options: Options) => {
      updateOptions?.(options);
    }),
    addListener: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return () => {
        listeners.delete(event);
      };
    }),
  };
  function Probe() {
    geometry = useStateSurface();
    return null;
  }
  function NativeScreen({
    children,
    nativeProps,
  }: {
    children: ReactNode;
    nativeProps?: NativeProps;
  }): ReactNode {
    useImperativeHandle(nativeProps?.ref, () => node);
    return children;
  }
  function Harness() {
    const [options, setOptions] = useState(initialOptions);
    currentOptions = options;
    updateOptions = next => {
      setOptions(previous => ({ ...previous, ...next }));
    };
    const navigationMock = navigation as Partial<SurfaceProps['navigation']>;
    const props: Partial<SurfaceProps> = {
      options,
      navigation: navigationMock as SurfaceProps['navigation'],
    };
    return (
      <NativeScreen nativeProps={options.unstable_nativeProps}>
        <NativeStateSurface {...(props as SurfaceProps)}>
          <Probe />
        </NativeStateSurface>
      </NativeScreen>
    );
  }
  return {
    mount: async () => {
      const mounted = await renderWithProviders(createElement('Root'));
      await act(async () => {
        await Promise.resolve();
        mounted.renderer.update(
          createElement(strict ? StrictMode : 'Root', null, createElement(Harness))
        );
      });
      return mounted;
    },
    node,
    navigation,
    listeners,
    measurements,
    geometry: () => geometry,
    props: () => currentOptions.unstable_nativeProps,
    update: async (options: Options) => {
      await act(async () => {
        await Promise.resolve();
        updateOptions?.(options);
      });
    },
    settle: async (top = 0, height = 800) => {
      await act(async () => {
        await Promise.resolve();
        for (const onMeasure of measurements.splice(0)) {
          onMeasure(0, top, 400, height);
        }
      });
    },
  };
}

beforeEach(() => {
  geometryHook.mockClear();
  platform.OS = 'ios';
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (onFrame: FrameRequestCallback) =>
    setTimeout(() => {
      onFrame(0);
    }, 16)
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NativeStateSurface refs', () => {
  it('observes native geometry only while a centered state is present', async () => {
    const harness = createHarness();
    const mounted = await harness.mount();
    expect(geometryHook).toHaveBeenLastCalledWith(null);
    let release: (() => void) | undefined = undefined;
    act(() => {
      release = harness.geometry()?.register();
    });
    expect(geometryHook).toHaveBeenLastCalledWith(harness.node);
    act(() => {
      release?.();
    });
    expect(geometryHook).toHaveBeenLastCalledWith(null);
    mounted.unmount();
  });

  it.each([false, true])(
    'preserves replacement props without a render loop in StrictMode %s',
    async strict => {
      const firstRef = createRef<View>();
      const nextRef = createRef<View>();
      const firstLayout = vi.fn<NonNullable<NativeProps['onLayout']>>();
      const nextLayout = vi.fn<NonNullable<NativeProps['onLayout']>>();
      const harness = createHarness(
        { unstable_nativeProps: { ref: firstRef, onLayout: firstLayout } },
        strict
      );
      const mounted = await harness.mount();
      await harness.settle();
      expect(firstRef.current).toBe(harness.node);
      expect(harness.geometry()?.frame).toEqual({ top: 0, bottom: 800 });
      expect(harness.navigation.setOptions).toHaveBeenCalledTimes(1);

      const replacement = { ref: nextRef, onLayout: nextLayout, testID: 'replacement' };
      await harness.update({ unstable_nativeProps: replacement });
      expect(firstRef.current).toBeNull();
      expect(nextRef.current).toBe(harness.node);
      expect(harness.geometry()?.frame).toBeNull();
      expect(harness.props()?.testID).toBe('replacement');
      expect(harness.navigation.setOptions).toHaveBeenCalledTimes(2);
      const event: Partial<LayoutChangeEvent> = {
        nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } },
      };
      harness.props()?.onLayout?.(event as LayoutChangeEvent);
      expect(firstLayout).not.toHaveBeenCalled();
      expect(nextLayout).toHaveBeenCalledWith(event);
      await harness.settle(300, 500);
      expect(harness.geometry()?.frame).toEqual({ top: 300, bottom: 800 });

      await act(async () => {
        await Promise.resolve();
        harness.listeners.get('focus')?.();
      });
      expect(harness.navigation.setOptions).toHaveBeenCalledTimes(2);
      expect(harness.props()?.testID).toBe('replacement');
      await harness.update({ unstable_nativeProps: replacement });
      expect(harness.navigation.setOptions).toHaveBeenCalledTimes(3);
      expect(harness.props()?.ref).not.toBe(replacement.ref);
      expect(nextRef.current).toBe(harness.node);
      mounted.unmount();
      expect(nextRef.current).toBeNull();
    }
  );

  it('preserves external refs when a caller copies the installed props', async () => {
    const ref = createRef<View>();
    const onLayout = vi.fn<NonNullable<NativeProps['onLayout']>>();
    const harness = createHarness({ unstable_nativeProps: { ref, onLayout } }, true);
    const mounted = await harness.mount();
    await harness.settle();
    await harness.update({ unstable_nativeProps: { ...harness.props(), testID: 'copied' } });
    await harness.settle();
    expect(ref.current).toBe(harness.node);
    expect(harness.navigation.setOptions).toHaveBeenCalledTimes(2);
    expect(harness.props()?.testID).toBe('copied');
    mounted.unmount();
    expect(ref.current).toBeNull();
  });

  it('invalidates detached measurements and accepts a fresh attachment', async () => {
    const harness = createHarness();
    const mounted = await harness.mount();
    await harness.settle();
    const ref = harness.props()?.ref;
    if (typeof ref !== 'function') {
      throw new TypeError('Expected a measuring callback ref');
    }
    act(() => {
      ref(harness.node);
    });
    const pending = harness.measurements.splice(0);
    act(() => {
      ref(null);
    });
    expect(harness.geometry()?.frame).toBeNull();
    act(() => {
      for (const onMeasure of pending) {
        onMeasure(0, 100, 400, 700);
      }
    });
    expect(harness.geometry()?.frame).toBeNull();
    act(() => {
      ref(harness.node);
    });
    await harness.settle(300, 500);
    expect(harness.geometry()?.frame).toEqual({ top: 300, bottom: 800 });
    mounted.unmount();
  });

  it('clears invalid measurements and pairs callback ref cleanup', async () => {
    const cleanup = vi.fn<() => void>();
    const ref = vi.fn((node: View | null) => (node ? cleanup : undefined));
    const harness = createHarness({ unstable_nativeProps: { ref } }, true);
    const mounted = await harness.mount();
    await harness.settle();
    const assignments = () => ref.mock.calls.filter(([node]) => node !== null).length;
    expect(assignments() - cleanup.mock.calls.length).toBe(1);
    await harness.update({ unstable_nativeProps: undefined });
    expect(cleanup).toHaveBeenCalledTimes(assignments());
    await harness.settle(0, 0);
    expect(harness.geometry()?.frame).toBeNull();
    mounted.unmount();
  });
});

describe('native viewport policy', () => {
  it.each([
    ['ios', 'formSheet', true],
    ['ios', 'card', false],
    ['ios', 'modal', false],
    ['android', 'formSheet', false],
  ] as const)('uses native fill only for %s %s', async (os, presentation, expected) => {
    platform.OS = os;
    const harness = createHarness({ presentation });
    const mounted = await harness.mount();
    expect(harness.geometry()?.nativeViewportFillsSurface).toBe(expected);
    mounted.unmount();
  });

  it('does not apply native fill to an explicit surface inside a modal', async () => {
    let geometry: ReturnType<typeof useStateSurface> = null;
    function Probe() {
      geometry = useStateSurface();
      return null;
    }
    const mounted = await renderWithProviders(
      createElement(StateSurface, null, createElement(Probe))
    );
    expect(geometry).toMatchObject({ nativeViewportFillsSurface: false });
    mounted.unmount();
  });
});
