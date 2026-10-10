import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';

// Android rejects activate and deactivate when the activity is gone, for
// example after it was destroyed while the JS runtime lived on. A rejected
// deactivate leaves the tag held natively, and a held tag makes the next
// activation skip the screen-on flag on the recreated window. Such tags are
// released before the next activation.
const unreleasedTags = new Set<string>();

/** Releases a tag and remembers it when the activity was already gone. */
async function release(tag: string): Promise<void> {
  try {
    await deactivateKeepAwake(tag);
    unreleasedTags.delete(tag);
  } catch {
    unreleasedTags.add(tag);
  }
}

/**
 * Acquires the tag and returns whether it is now held. Retries are sequential:
 * the native module resolves each call on the same coroutine scope, so the
 * release of a stale tag must land before the next activation is queued.
 */
async function acquire(tag: string): Promise<boolean> {
  for (const unreleased of unreleasedTags) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design, see above.
    await release(unreleased);
  }
  try {
    await activateKeepAwakeAsync(tag);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the screen awake while the owner is mounted. Unlike the library hook,
 * it releases only a tag whose activation succeeded, and it never lets the
 * native rejection become an unhandled promise rejection.
 */
export function useKeepAwake(tag: string): void {
  useEffect(() => {
    let mounted = true;
    let activated = false;
    const run = async () => {
      const acquired = await acquire(tag);
      if (!acquired) {
        return;
      }
      if (mounted) {
        activated = true;
        return;
      }
      // The owner unmounted while the activity was gone: release the tag the
      // activation just took.
      await release(tag);
    };
    void run();
    return () => {
      mounted = false;
      if (activated) {
        void release(tag);
      }
    };
  }, [tag]);
}
