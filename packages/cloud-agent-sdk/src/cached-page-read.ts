/**
 * Reads a cached transcript page and applies it. A reader that answers
 * synchronously has its page applied before this returns, so the reopened
 * session is on screen before the caller's next paint. An unreadable cache is
 * a miss, never a failed session load.
 *
 * Returns the read while it is still in flight, or `null` once it has settled.
 */
export function readCachedPage<Page extends object>(
  read: () => Page | null | Promise<Page | null>,
  apply: (page: Page | null) => void
): Promise<void> | null {
  let cached: Page | null | Promise<Page | null> = null;
  try {
    cached = read();
  } catch {
    // A miss.
  }
  if (cached === null || !('then' in cached)) {
    apply(cached);
    return null;
  }
  return cached.then(apply).catch(() => {
    // A miss.
  });
}
