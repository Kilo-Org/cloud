import { requireOptionalNativeModule } from 'expo';

/**
 * The range of React view tags this JavaScript instance may hand out.
 *
 * React Native allocates view tags in JavaScript, from the first tag of every instance, and
 * Android keeps state keyed by those tags for the life of the process: the measured text of
 * every text input is cached under the input's tag, and freed when a text input carrying the
 * same tag is collected. A reloaded instance would reissue the tags the previous instance's
 * inputs still hold, and one of those inputs being collected would take the measurement of a
 * live one with it. Each instance therefore claims its own range from `KiloViewTagRange`, and
 * the renderer starts its tags from the base this module publishes.
 *
 * This is the one place the app reaches `expo`'s module registry for the range, so a test
 * project that has no Expo runtime can mock this module instead, and a build without the
 * module starts at the platform's own first tag.
 */
type ViewTagRangeModule = { claimRange: () => number };

const nativeModule = requireOptionalNativeModule<ViewTagRangeModule>('KiloViewTagRange');

declare global {
  /**
   * Where this instance's React view tags start. The renderer is a standalone bundle that
   * cannot import app modules, so the claimed base travels to it through the global scope.
   */
  // eslint-disable-next-line no-var -- the renderer bundle reads a global binding
  var __kiloViewTagBase: number | undefined;
}

/**
 * Claim this instance's tag range. Call it once, before the first render: the renderer reads
 * the published base when it allocates its first tag. A build or runtime that cannot answer
 * starts at the platform's own first tag, which is the behaviour the app had before ranges.
 */
export function claimViewTagRange(): number {
  let claimed: number | undefined;
  try {
    claimed = nativeModule?.claimRange();
  } catch {
    claimed = undefined;
  }
  const base =
    typeof claimed === 'number' && Number.isSafeInteger(claimed) && claimed > 0 ? claimed : 0;
  globalThis.__kiloViewTagBase = base;
  return base;
}
