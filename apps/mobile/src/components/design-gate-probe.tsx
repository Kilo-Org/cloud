import { usePathname, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';
import { LogBox, View, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DESIGN_GATE_ANCHOR_ID } from '@/lib/design-gate/collect';
import { createDesignGateApi, type DesignGateApi } from '@/lib/design-gate/probe';

declare global {
  // eslint-disable-next-line no-var -- a global the design-gate runner reads over the Metro inspector
  var __kiloDesignGate: DesignGateApi | undefined;
  // eslint-disable-next-line no-var -- the prepared-tree receipt `design-gate prepare` writes
  var __kiloDesignProofSource: string | undefined;
}

/**
 * React reports this when a screen's own `onLayout` measurement callback sets
 * state in the same tick the view tree is placed — the gate hits it when a
 * cell's configuration change re-lays out the mounted tab screen (reproduced on
 * the emulator; a second identical run was clean, so it is a timing race, not a
 * state). The measurement is legitimate by design: the height is unknowable
 * before layout, and the guarded setter is a no-op on an unchanged value.
 *
 * `LogBox.ignoreLogs` is process-global, so the ignore is gated on the prepared
 * tree's receipt: `design-gate prepare` writes `__kiloDesignProofSource` into
 * `+native-intent.tsx` of exactly the two worktrees it creates, and no other
 * bundle defines it. Every ordinary dev build therefore keeps the message as
 * the live defect signal it is (`setThemePreference` orders its writes around
 * exactly this warning), and the gate's capture measures the screen instead of
 * its own overlay — with no operator step and no Metro cache coupling.
 *
 * The receipt is written at the END of `+native-intent.tsx`, so its module can
 * be evaluated after this component's mount effect ran and skipped the ignore;
 * the probe therefore also installs the filters on first probe use (`ready()`/
 * `dump()`), and LogBox re-filters logs it already holds, removing a
 * notification shown earlier.
 */
const DESIGN_GATE_IGNORED_LOGS = [
  "Can't perform a React state update on a component that hasn't mounted yet.",
] as const;

/**
 * Installs the ignored messages above in any prepared design-gate bundle.
 * Idempotent: LogBox dedupes patterns, so repeat calls are cheap; adding a
 * pattern re-filters the logs it already holds, so a notification shown before
 * the receipt module was evaluated disappears.
 */
function installDesignGateLogFilters() {
  if (globalThis.__kiloDesignProofSource !== undefined) {
    LogBox.ignoreLogs([...DESIGN_GATE_IGNORED_LOGS]);
  }
}

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
    installDesignGateLogFilters();
    const api = createDesignGateApi({
      document: () => anchor.current?.ownerDocument ?? null,
      route: () => route.current,
      screen: () => screen.current,
      safeArea: () => safeArea.current,
      ensureLogFilters: installDesignGateLogFilters,
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
