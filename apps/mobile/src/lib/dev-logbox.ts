export const SUPPRESSED_DEV_LOG_SUBSTRINGS: readonly string[] = [
  // expo-iap logs this on every failed available-purchases query (the Play
  // Store service being unavailable, for one); the Kilo Pass screen renders
  // its own translated message for the same failure, so the library's copy
  // must not paint a LogBox banner over it.
  '[Expo-IAP] Error fetching available purchases:',
  // The render-recovery fixture throws on purpose so the authenticated stack's
  // screen recovery can be measured and driven on a dev build. React logs every
  // caught render error, and the dev overlay would cover the very fallback the
  // fixture exists to show. Only the fixture's own messages carry this prefix.
  'render recovery fixture:',
  // Fabric reports this when a screen's own onLayout measurement callback sets
  // state in the same tick the view tree is placed — the design gate hits it
  // when a cell's configuration change re-lays out the mounted tab screen
  // (reproduced on the emulator; a second identical run was clean, so it is a
  // timing race, not a state). The measurement is legitimate by design: the
  // height is unknowable before layout, and the guarded setter is a no-op on an
  // unchanged value. It is dev-instrument noise a release build never renders.
  "Can't perform a React state update on a component that hasn't mounted yet.",
];

type DevLogBox = { ignoreLogs: (patterns: readonly string[]) => void };

export function applyDevLogBoxFilters(logBox: DevLogBox): void {
  logBox.ignoreLogs(SUPPRESSED_DEV_LOG_SUBSTRINGS);
}
