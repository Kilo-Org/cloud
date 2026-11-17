import { usePathname, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';
import { LogBox, View, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IS_DESIGN_GATE_BUNDLE } from '@/lib/config';
import { DESIGN_GATE_ANCHOR_ID } from '@/lib/design-gate/collect';
import { createDesignGateApi, type DesignGateApi } from '@/lib/design-gate/probe';

declare global {
  // eslint-disable-next-line no-var -- a global the design-gate runner reads over the Metro inspector
  var __kiloDesignGate: DesignGateApi | undefined;
}

/**
 * React reports this when a screen's own `onLayout` measurement callback sets
 * state in the same tick the view tree is placed — the gate hits it when a
 * cell's configuration change re-lays out the mounted tab screen (reproduced on
 * the emulator; a second identical run was clean, so it is a timing race, not a
 * state). The measurement is legitimate by design: the height is unknowable
 * before layout, and the guarded setter is a no-op on an unchanged value.
 *
 * `LogBox.ignoreLogs` is process-global, so the ignore is gated on the
 * bundle-time flag above: only a bundle served with
 * `EXPO_PUBLIC_DESIGN_GATE=1` — the gate runner's own Metro — drops it. Every
 * other dev build keeps the message as the live defect signal it is
 * (`setThemePreference` orders its writes around exactly this warning). The
 * gate's capture then measures the screen and not its own overlay.
 */
const DESIGN_GATE_IGNORED_LOGS = [
  "Can't perform a React state update on a component that hasn't mounted yet.",
] as const;

/**
 * Development-only: registers the design-gate layout probe while it is mounted.
 * The root layout renders it behind `__DEV__`. The zero-size anchor gives the
 * probe its document; it is absolutely positioned, so layout does not change.
 */
export function DesignGateProbe() {
  const anchor = useRef<ViewInstance>(null);
  const pathname = usePathname();
  const segments = useSegments();
  const screenKey = segments.join('/');
  const insets = useSafeAreaInsets();
  const route = useRef(pathname);
  const screen = useRef(screenKey);
  const safeArea = useRef(insets);
  useEffect(() => {
    route.current = pathname;
    // A tab change keeps the URL at `/`, so the focused segments are the only
    // evidence that another screen is on top.
    screen.current = screenKey;
    safeArea.current = insets;
  }, [pathname, screenKey, insets]);
  useEffect(() => {
    if (IS_DESIGN_GATE_BUNDLE) {
      LogBox.ignoreLogs([...DESIGN_GATE_IGNORED_LOGS]);
    }
    const api = createDesignGateApi({
      document: () => anchor.current?.ownerDocument ?? null,
      route: () => route.current,
      screen: () => screen.current,
      safeArea: () => safeArea.current,
    });
    globalThis.__kiloDesignGate = api;
    return () => {
      api.dispose();
      if (globalThis.__kiloDesignGate === api) {
        globalThis.__kiloDesignGate = undefined;
      }
    };
  }, []);
  return (
    <View
      ref={anchor}
      testID={DESIGN_GATE_ANCHOR_ID}
      pointerEvents="none"
      className="absolute h-0 w-0"
    />
  );
}
