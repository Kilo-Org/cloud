import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { findNodeHandle, Platform, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type SheetHeaderTopInset } from '@/lib/form-sheet';
import {
  isNativeSurfaceGeometryAvailable,
  presentedSurfaceOriginTop,
} from '@/lib/native-surface-geometry';
import {
  presentedSheetTopClearance,
  presentsAboveWindowInset,
} from '@/lib/presented-sheet-top-inset';

/**
 * When the header samples where the platform presented its surface, in ms after
 * the sheet opens a movement.
 *
 * The presentation is a native animation: the sheet slides up into place, and a
 * sample taken during it answers a position the sheet has already left. The
 * burst spans the presentation, and the last sample is the settled one.
 */
const PRESENT_SAMPLE_MS = [0, 120, 280, 500, 750, 1000];

/**
 * `findNodeHandle`, or null where the runtime does not expose it: a suite that
 * mocks `react-native` partially omits it, and vitest throws on the property
 * access rather than answering undefined (the same guard
 * `readInitialWindowMetrics` uses).
 */
function readViewTag(node: ViewInstance | null): number | null {
  if (node === null) {
    return null;
  }
  try {
    return findNodeHandle(node) ?? null;
  } catch {
    return null;
  }
}

/** What a sheet header reads from the platform that presented its surface. */
export type PresentedSheetTopClearance = {
  /** The top clearance the header adds, in points. */
  clearance: number;
  /** Re-reads the presented origin; the header's own `onLayout`. */
  onLayout: () => void;
};

/**
 * The clearance a sheet header adds because the platform presented its sheet
 * above the status bar, in points, plus the layout callback that re-reads it.
 *
 * iOS sizes a `formSheet` by its own maximum height rather than by a fixed
 * fraction of the window, so on a phone short enough the maximum *is* the
 * window and the sheet presents at the window top with its header inside the
 * status bar. Nothing inside the sheet can tell: `measureInWindow`,
 * `getBoundingClientRect` and the shadow tree's root metrics are all resolved
 * inside the presented content, so they report the sheet's own origin on a
 * phone where the sheet sits 62 points lower. The read that moves with the
 * presentation is the native one (`presentedSurfaceOriginTop`), which converts
 * the surface's origin into window coordinates.
 *
 * A surface the platform presented at or below the window's top inset keeps the
 * clearance its mode already reserved, so a standard phone's header does not
 * grow a dead band. `clearance` is therefore the input the settled Android read
 * already resolved, and this read only ever adds to it.
 */
export function usePresentedSheetTopClearance(input: {
  topInset: SheetHeaderTopInset | undefined;
  /** The clearance the header's surface mode and settled read resolved, in points. */
  clearance: number;
  /** The header's own view, read for its origin in window coordinates. */
  surfaceRef: RefObject<ViewInstance | null>;
}): PresentedSheetTopClearance {
  const { topInset, clearance, surfaceRef } = input;
  const insetTop = useSafeAreaInsets().top;
  // The origin the last burst settled on, keyed by that burst. Within one burst
  // the sheet only ever slides up, so the smallest value is the settled one; a
  // later burst (the sheet moved again) replaces it outright, because which edge
  // the presentation leaves is a question about where the sheet is now, not
  // about where it has ever been.
  const [settled, setSettled] = useState<{ burst: number; origin: number } | null>(null);
  // The burst in flight: a newer one retires every sample of the older ones, so
  // a sheet that moves again is only measured by the burst that followed it.
  const burstRef = useRef(0);
  // Whether this surface can use an origin at all. The rule reads the same
  // predicate, so a mode whose answer would be discarded — `never`,
  // `ios-page-sheet`, an Android surface, a window with no top inset — never
  // runs a burst: the sampling costs a native call per sample and could not
  // move the header.
  const readable =
    isNativeSurfaceGeometryAvailable &&
    presentsAboveWindowInset({ topInset, platform: Platform.OS, insetTop });

  const sample = useCallback(
    async (burst: number) => {
      // The tag is resolved per sample, not once at mount: a header's first
      // layout can arrive before its view is registered, and a view that
      // remounts hands over a new one.
      const tag = readViewTag(surfaceRef.current);
      if (tag === null) {
        return;
      }
      let origin: number | null = null;
      try {
        origin = await presentedSurfaceOriginTop(tag);
      } catch {
        // A sheet dismissed mid-burst has no window to convert into; the header
        // keeps the clearance it has rather than taking the app down.
        return;
      }
      // The burst that owed this read guards it, so a sample whose sheet has
      // already moved again publishes nothing.
      if (burstRef.current !== burst || origin === null) {
        return;
      }
      setSettled(current =>
        current?.burst === burst && current.origin <= origin ? current : { burst, origin }
      );
    },
    [surfaceRef]
  );

  const followPresentation = useCallback(() => {
    const burst = burstRef.current + 1;
    burstRef.current = burst;
    for (const delayMs of PRESENT_SAMPLE_MS) {
      setTimeout(() => {
        if (burstRef.current === burst) {
          void sample(burst);
        }
      }, delayMs);
    }
  }, [sample]);

  useEffect(() => {
    if (!readable) {
      return undefined;
    }
    setSettled(null);
    followPresentation();
    return () => {
      // Retires the samples still owed to this mount.
      burstRef.current += 1;
    };
  }, [readable, followPresentation]);

  const onLayout = useCallback(() => {
    if (readable) {
      followPresentation();
    }
  }, [readable, followPresentation]);

  return {
    clearance: presentedSheetTopClearance({
      topInset,
      platform: Platform.OS,
      insetTop,
      surfaceOriginTop: settled?.origin ?? null,
      clearance,
    }),
    onLayout,
  };
}
