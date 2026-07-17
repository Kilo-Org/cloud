// Pure threshold check — kept separate from the hook so it can be unit-tested
// without pulling in the React Native runtime (which doesn't parse under the
// vitest/Vite environment).

const TABLET_MIN_SHORT_EDGE = 600;

export function isTabletFromDimensions(width: number, height: number, isPad: boolean): boolean {
  if (isPad) {
    return true;
  }
  return Math.min(width, height) >= TABLET_MIN_SHORT_EDGE;
}
