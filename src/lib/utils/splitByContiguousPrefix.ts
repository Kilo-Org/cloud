/**
 * Splits an array into a "static" contiguous prefix and a "dynamic" tail.
 *
 * Walks from the start, extending the prefix as long as every item satisfies
 * `isComplete`. The first item that fails the predicate (or a gap after such
 * an item) ends the prefix; everything from that point onward goes into the
 * dynamic portion. This keeps items in their original order — items that fail
 * the predicate are never reordered past items that pass it.
 */
export function splitByContiguousPrefix<T>(
  items: readonly T[],
  isComplete: (item: T) => boolean
): { staticItems: T[]; dynamicItems: T[] } {
  let lastCompleteIndex = -1;

  for (let i = 0; i < items.length; i++) {
    if (isComplete(items[i])) {
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
