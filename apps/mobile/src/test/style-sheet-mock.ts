/** A style entry as React Native merges it: one flat object of properties. */
export type FlatStyle = Record<string, unknown>;

/**
 * `StyleSheet.flatten` for a suite that stubs `react-native`: the nested arrays
 * merged left to right, so the last entry naming a property wins, and a
 * non-object answer of `undefined`, exactly as the real module answers.
 *
 * A suite's `react-native` mock must provide this because the shared `Text`
 * reads a caller's own base direction through it (`pinsTextDirection`). An
 * identity stub would answer the array unchanged and hide that read.
 */
export function flattenStyle(style: unknown): FlatStyle | undefined {
  if (style === null || style === undefined || typeof style !== 'object') {
    return undefined;
  }
  if (!Array.isArray(style)) {
    return { ...style };
  }
  const merged: FlatStyle = {};
  for (const entry of style as unknown[]) {
    Object.assign(merged, flattenStyle(entry));
  }
  return merged;
}
