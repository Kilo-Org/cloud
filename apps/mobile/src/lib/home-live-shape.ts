import * as SecureStore from '@/lib/auth/secure-store';
import { HOME_LIVE_SHAPE_KEY } from '@/lib/storage-keys';

/**
 * The shape the Home `Live now` section last settled on. The live list is not
 * in the read cache, so every cold start begins pending; the placeholder takes
 * this shape so the arriving content replaces a box of its own height instead
 * of a 215px card collapsing to the 72px `Nothing running` card. The value is
 * read synchronously because the first frame already draws the placeholder.
 * It is a layout hint only: no count, title or id is stored.
 */
export type LiveShape = 'rows' | 'empty';

let cached: LiveShape | undefined = undefined;

export function readLiveShapeHint(): LiveShape {
  if (cached === undefined) {
    try {
      cached = SecureStore.getItem(HOME_LIVE_SHAPE_KEY) === 'empty' ? 'empty' : 'rows';
    } catch {
      cached = 'rows';
    }
  }
  return cached;
}

export function persistLiveShapeHint(shape: LiveShape): void {
  if (cached === shape) {
    return;
  }
  cached = shape;
  try {
    SecureStore.setItem(HOME_LIVE_SHAPE_KEY, shape);
  } catch {
    // A failed write only costs the next cold start its matching placeholder.
  }
}

/** Sign-out: the next account starts from the default card placeholder. */
export async function clearLiveShapeHint(): Promise<void> {
  cached = 'rows';
  await SecureStore.deleteItemAsync(HOME_LIVE_SHAPE_KEY);
}
