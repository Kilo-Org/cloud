export const SUPPRESSED_DEV_LOG_SUBSTRINGS: readonly string[] = [
  // expo-iap logs this on every failed available-purchases query (the Play
  // Store service being unavailable, for one); the Kilo Pass screen renders
  // its own translated message for the same failure, so the library's copy
  // must not paint a LogBox banner over it.
  '[Expo-IAP] Error fetching available purchases:',
];

type DevLogBox = { ignoreLogs: (patterns: readonly string[]) => void };

export function applyDevLogBoxFilters(logBox: DevLogBox): void {
  logBox.ignoreLogs(SUPPRESSED_DEV_LOG_SUBSTRINGS);
}
