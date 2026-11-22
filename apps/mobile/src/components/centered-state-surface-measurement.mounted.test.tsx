import {
  act,
  type ComponentProps,
  type ComponentPropsWithRef,
  createElement,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useState,
} from 'react';
import { type View, type ViewInstance } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { NativeStateSurface, StateSurface, useStateSurface } from './centered-state-surface';

/**
 * One native `measureInWindow` pass per attach.
 *
 * The hook used to measure from both the ref callback and the mount layout
 * effect, so one attach spent two native layout measurements and the first was
 * superseded by the second on the next frame.
 */

type SurfaceProps = ComponentProps<typeof NativeStateSurface>;
type Options = SurfaceProps['options'];
type MeasureInWindow = Parameters<ViewInstance['measureInWindow']>[0];

const geometryHook = vi.hoisted(() => vi.fn(() => ({ status: 'unavailable', geometry: null })));
vi.mock('@/lib/hooks/use-native-state-geometry', () => ({ useNativeStateGeometry: geometryHook }));

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const viewMeasurements = vi.hoisted(() => ({ pending: [] as MeasureInWindow[] }));
vi.mock('react-native', () => ({
  Platform: platform,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  View: ({ ref, ...props }: ComponentPropsWithRef<typeof View>) => {
    useImperativeHandle(ref, () => {
      const handle: Partial<ViewInstance> = {
        measureInWindow: onMeasure => {
          viewMeasurements.pending.push(onMeasure);
        },
      };
      return handle as ViewInstance;
    }, []);
    return createElement('View', props);
  },
}));

function createHarness(initialOptions: Options) {
  const measurements: MeasureInWindow[] = [];
  const node = {
    measureInWindow: (onMeasure: MeasureInWindow) => {
      measurements.push(onMeasure);
    },
    scrollTop: 0,
  } as unknown as ViewInstance;
  let updateOptions: ((options: Options) => void) | undefined = undefined;
  let currentOptions = initialOptions;
  let geometry: ReturnType<typeof useStateSurface> = null;
  const navigation = {
    isFocused: () => true,
    setOptions: (options: Options) => {
      updateOptions?.(options);
    },
    addListener: () => () => undefined,
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
    nativeProps?: Options['unstable_nativeProps'];
  }): ReactNode {
    // A callback ref is called on attach and nulled on detach, and React only
    // repeats that when its identity changes; the harness does the same so the
    // hook sees the navigator's real attach/detach rhythm.
    const installed = nativeProps?.ref;
    useLayoutEffect(() => {
      if (typeof installed === 'function') {
        installed(node);
      }
      return () => {
        if (typeof installed === 'function') {
          installed(null);
        }
      };
    }, [installed]);
    return children;
  }
  function Harness() {
    const [options, setOptions] = useState(initialOptions);
    currentOptions = options;
    updateOptions = next => {
      setOptions(previous => ({ ...previous, ...next }));
    };
    return (
      <NativeScreen nativeProps={options.unstable_nativeProps}>
        <NativeStateSurface {...({ options, navigation } as unknown as SurfaceProps)}>
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
        mounted.renderer.update(createElement(Harness));
      });
      return mounted;
    },
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
  viewMeasurements.pending.length = 0;
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

describe('surface measurement ownership', () => {
  it('spends one native measurement per surface attach', async () => {
    const probe: { geometry: ReturnType<typeof useStateSurface> } = { geometry: null };
    function Probe() {
      probe.geometry = useStateSurface();
      return null;
    }
    const mounted = await renderWithProviders(
      createElement(StateSurface, null, createElement(Probe))
    );
    expect(viewMeasurements.pending).toHaveLength(1);
    const pending = viewMeasurements.pending.splice(0);
    act(() => {
      for (const onMeasure of pending) {
        onMeasure(0, 0, 400, 800);
      }
    });
    expect(probe.geometry?.frame).toEqual({ top: 0, bottom: 800 });
    mounted.unmount();
  });

  it('re-measures a sheet toggle without re-attaching the ref', async () => {
    platform.OS = 'android';
    const harness = createHarness({ presentation: 'modal' });
    const mounted = await harness.mount();
    const installed = harness.props()?.ref;
    expect(harness.measurements).toHaveLength(1);
    await harness.settle();
    expect(harness.geometry()?.frame).toEqual({ top: 0, bottom: 800 });
    await harness.update({ presentation: 'card' });
    expect(harness.props()?.ref).toBe(installed);
    expect(harness.measurements).toHaveLength(1);
    await harness.settle(100, 500);
    expect(harness.geometry()?.frame).toEqual({ top: 100, bottom: 600 });
    mounted.unmount();
  });
});
