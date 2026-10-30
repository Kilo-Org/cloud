import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DESIGN_GATE_ANCHOR_ID } from '@/lib/design-gate/collect';
import { createDesignGateApi, type DesignGateApi } from '@/lib/design-gate/probe';

declare global {
  // eslint-disable-next-line no-var -- a global the design-gate runner reads over the Metro inspector
  var __kiloDesignGate: DesignGateApi | undefined;
}

/**
 * Development-only: registers the design-gate layout probe while it is mounted.
 * The root layout renders it behind `__DEV__`. The zero-size anchor gives the
 * probe its document; it is absolutely positioned, so layout does not change.
 */
export function DesignGateProbe() {
  const anchor = useRef<ViewInstance>(null);
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const route = useRef(pathname);
  const safeArea = useRef(insets);
  useEffect(() => {
    route.current = pathname;
    safeArea.current = insets;
  }, [pathname, insets]);
  useEffect(() => {
    const api = createDesignGateApi({
      document: () => anchor.current?.ownerDocument ?? null,
      route: () => route.current,
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
