import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  View,
  type ViewInstance,
  type ViewProps,
} from 'react-native';
import { type Stack } from 'expo-router';
import { type ParamListBase } from 'expo-router/react-navigation';
import { type NativeStackNavigationProp } from 'expo-router/native-stack';

import { getBottomReservation, getStateSurfaceInsets } from '@/lib/centered-state-layout';
import {
  type SurfaceMeasurement,
  useStateSurfaceMeasurement,
} from '@/lib/hooks/use-state-surface-measurement';

type SurfaceGeometry = SurfaceMeasurement & {
  topInset: number;
  bottomInset: number;
  topReservation: number;
  bottomReservation: number;
  nativeViewportFillsSurface: boolean;
  register: () => () => void;
};

type ScreenLayoutProps = Omit<
  Parameters<NonNullable<ComponentProps<typeof Stack>['screenLayout']>>[0],
  'navigation'
> & {
  navigation: Pick<
    NativeStackNavigationProp<ParamListBase>,
    // `getState`/`reset` let a scene layout repair the Stack it belongs to —
    // a screen that a fresh destination opened on its own has no parent to
    // pop to (see use-repair-security-agent-scope-stack).
    'setOptions' | 'isFocused' | 'addListener' | 'getState' | 'reset'
  >;
};

export type { ScreenLayoutProps };

const StateSurfaceContext = createContext<SurfaceGeometry | null>(null);

export function useStateSurface() {
  return useContext(StateSurfaceContext);
}

function useSurfaceRegistration() {
  const [count, setCount] = useState(0);
  const register = useCallback(() => {
    setCount(current => current + 1);
    return () => {
      setCount(current => current - 1);
    };
  }, []);
  return { active: count > 0, register };
}

function resolveSurfaceGeometry(
  measurement: SurfaceMeasurement,
  reservations: {
    top: number;
    bottom: number;
    nativeViewportFillsSurface: boolean;
    register: () => () => void;
  }
): SurfaceGeometry {
  const { frame, bounds, safeAreaTop, safeAreaBottom } = measurement;
  const insets =
    frame && bounds
      ? getStateSurfaceInsets({
          surface: frame,
          bounds,
          top: Math.max(safeAreaTop, reservations.top),
          bottom: Math.max(safeAreaBottom, reservations.bottom),
        })
      : { topInset: 0, bottomInset: 0 };
  return {
    frame,
    bounds,
    safeAreaTop,
    safeAreaBottom,
    source: measurement.source,
    failure: measurement.failure,
    ...insets,
    topReservation: reservations.top,
    bottomReservation: reservations.bottom,
    nativeViewportFillsSurface: reservations.nativeViewportFillsSurface,
    register: reservations.register,
  };
}

export function StateSurface({
  children,
  onLayout,
  topInset = 0,
  bottomInset = 0,
  ...props
}: ViewProps & {
  topInset?: number;
  bottomInset?: number;
}) {
  const { active, register } = useSurfaceRegistration();
  const measurement = useStateSurfaceMeasurement(false, active);
  const { capture, measure } = measurement;
  const geometry = useMemo(
    () =>
      resolveSurfaceGeometry(measurement, {
        top: topInset,
        bottom: bottomInset,
        nativeViewportFillsSurface: false,
        register,
      }),
    [measurement, topInset, bottomInset, register]
  );
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLayout?.(event);
      measure();
    },
    [measure, onLayout]
  );

  return (
    <StateSurfaceContext value={geometry}>
      <View {...props} ref={capture} collapsable={false} onLayout={handleLayout}>
        {children}
      </View>
    </StateSurfaceContext>
  );
}

export function NativeStateSurface({ children, navigation, options }: ScreenLayoutProps) {
  const modal = options.presentation !== undefined && options.presentation !== 'card';
  const parent = useStateSurface();
  const { active, register } = useSurfaceRegistration();
  const measurement = useStateSurfaceMeasurement(Platform.OS === 'android' && modal, active);
  const { capture, measure, node: nativeNode } = measurement;
  const installedPropsRef = useRef<ScreenLayoutProps['options']['unstable_nativeProps']>(undefined);
  const observedPropsRef = useRef(options.unstable_nativeProps);
  // The props the navigator hands over, with the ref and layout handler the
  // installed set already owns. Derived in a ref, not state: the value is read
  // in the same render, and setting state during render is the update React
  // rejects on a scene that has not mounted yet (`setThemePreference` orders
  // its writes around the same warning).
  const derivedPropsRef = useRef({
    incoming: options.unstable_nativeProps,
    external: options.unstable_nativeProps,
  });
  const incomingProps = options.unstable_nativeProps;
  if (incomingProps !== derivedPropsRef.current.incoming) {
    const installed = installedPropsRef.current;
    const previous = derivedPropsRef.current.external;
    derivedPropsRef.current = {
      incoming: incomingProps,
      external: incomingProps && {
        ...incomingProps,
        ref:
          installed && incomingProps.ref === installed.ref ? previous?.ref : incomingProps.ref,
        onLayout:
          installed && incomingProps.onLayout === installed.onLayout
            ? previous?.onLayout
            : incomingProps.onLayout,
      },
    };
  }
  const externalProps = derivedPropsRef.current.external;
  useImperativeHandle<ViewInstance | null, ViewInstance | null>(
    externalProps?.ref,
    () => nativeNode,
    [nativeNode]
  );
  const scheduledRef = useRef<number | null>(null);
  const schedule = useCallback(() => {
    if (scheduledRef.current !== null) {
      cancelAnimationFrame(scheduledRef.current);
    }
    scheduledRef.current = requestAnimationFrame(() => {
      scheduledRef.current = null;
      measure();
    });
  }, [measure]);
  const nativeProps = useMemo(
    () => ({
      ...externalProps,
      ref: capture,
      onLayout: (event: LayoutChangeEvent) => {
        externalProps?.onLayout?.(event);
        schedule();
      },
    }),
    [capture, externalProps, schedule]
  );

  useLayoutEffect(() => {
    const attach = () => {
      const incomingChanged = observedPropsRef.current !== options.unstable_nativeProps;
      observedPropsRef.current = options.unstable_nativeProps;
      if (
        installedPropsRef.current !== nativeProps ||
        (incomingChanged && options.unstable_nativeProps !== nativeProps)
      ) {
        installedPropsRef.current = nativeProps;
        navigation.setOptions({ unstable_nativeProps: nativeProps });
      }
      schedule();
    };
    if (navigation.isFocused()) {
      attach();
    }
    return navigation.addListener('focus', attach);
  }, [nativeProps, navigation, options.unstable_nativeProps, schedule]);

  useEffect(() => {
    const removeTransition = navigation.addListener('transitionEnd', schedule);
    const removeDetent = navigation.addListener('sheetDetentChange', schedule);
    return () => {
      removeTransition();
      removeDetent();
      if (scheduledRef.current !== null) {
        cancelAnimationFrame(scheduledRef.current);
        scheduledRef.current = null;
      }
    };
  }, [navigation, schedule]);

  const nativeViewportFillsSurface = Platform.OS === 'ios' && options.presentation === 'formSheet';
  const topReservation = modal ? 0 : (parent?.topReservation ?? 0);
  const bottomReservation = modal ? 0 : (parent?.bottomReservation ?? 0);
  const geometry = useMemo(
    () =>
      resolveSurfaceGeometry(measurement, {
        top: topReservation,
        bottom: bottomReservation,
        nativeViewportFillsSurface,
        register,
      }),
    [measurement, topReservation, bottomReservation, nativeViewportFillsSurface, register]
  );
  return <StateSurfaceContext value={geometry}>{children}</StateSurfaceContext>;
}

export function StateSurfaceInsets({
  children,
  bottomInset,
}: {
  children: ReactNode;
  /** Raised onto the inherited bottom reservation: a nested surface can only
   *  add clearance, never shrink it. The tabs layout reserves the tab bar alone
   *  (its content gap is content-only), so the Agents screen's `tabBarHeight +
   *  fabBand` is the whole reserve its centered states resolve. */
  bottomInset: number;
}) {
  const surface = useStateSurface();
  const geometry = useMemo(
    () =>
      surface
        ? resolveSurfaceGeometry(surface, {
            top: surface.topReservation,
            bottom: getBottomReservation({
              inherited: surface.bottomReservation,
              bottomInset,
            }),
            nativeViewportFillsSurface: surface.nativeViewportFillsSurface,
            register: surface.register,
          })
        : null,
    [surface, bottomInset]
  );
  return <StateSurfaceContext value={geometry}>{children}</StateSurfaceContext>;
}
