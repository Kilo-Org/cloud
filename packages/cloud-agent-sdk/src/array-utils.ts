/**
 * Splits an array into a "static" contiguous prefix and a "dynamic" tail.
 */
export function splitByContiguousPrefix<T>(
  items: readonly T[],
  isComplete: (item: T) => boolean
): { staticItems: T[]; dynamicItems: T[] } {
  let lastCompleteIndex = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined && isComplete(item)) {
      if (i === 0 || i === lastCompleteIndex + 1) {
        lastCompleteIndex = i;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return {
    staticItems: items.slice(0, lastCompleteIndex + 1),
    dynamicItems: items.slice(lastCompleteIndex + 1),
  };
}
