import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';

// The native module keeps tags in a plain set: one release drops a tag for
// every owner, so only the last mounted owner of a tag releases it.
const owners = new Map<string, number>();
// Tags whose activation succeeded and that no release has dropped since.
const heldTags = new Set<string>();
// Android rejects activate and deactivate when the activity is gone, for
// example after it was destroyed while the JS runtime lived on. A rejected
// deactivate leaves the tag held natively, and a held tag makes the next
// activation skip the screen-on flag on the recreated window. Such tags are
// released before the next activation.
const unreleasedTags = new Set<string>();

function removeOwner(tag: string): void {
  const remaining = (owners.get(tag) ?? 1) - 1;
  if (remaining > 0) {
    owners.set(tag, remaining);
  } else {
    owners.delete(tag);
  }
}

/** Releases a tag and remembers it when the activity was already gone. */
async function release(tag: string): Promise<void> {
  try {
    await deactivateKeepAwake(tag);
    heldTags.delete(tag);
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
    heldTags.add(tag);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the screen awake while the owner is mounted. Unlike the library hook,
 * it releases only a tag whose activation succeeded, it never releases a tag
 * another mounted owner still needs, and it never lets the native rejection
 * become an unhandled promise rejection.
 */
export function useKeepAwake(tag: string): void {
  useEffect(() => {
    owners.set(tag, (owners.get(tag) ?? 0) + 1);
    const run = async () => {
      const acquired = await acquire(tag);
      // Every owner left while the activation was in flight: release the tag
      // it just took.
      if (acquired && !owners.has(tag)) {
        await release(tag);
      }
    };
    void run();
    return () => {
      removeOwner(tag);
      if (heldTags.has(tag) && !owners.has(tag)) {
        void release(tag);
      }
    };
  }, [tag]);
}
