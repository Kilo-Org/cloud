import { useRef } from 'react';

import { createFrameCoalescer } from '@/lib/coalesce-frame';

/**
 * One tail correction per animation frame, however many layout or content-size
 * events ask for it.
 *
 * A keyboard slide reports several layout passes, and the composer beside the
 * transcript changes the content height in the same frame; correcting each of
 * those events hard-scrolls the list several times per frame. The guards are
 * re-read when the frame runs, so a drag or a scroll away that lands in between
 * still wins, and `cancel` on unmount drops a pending correction.
 */
export function useSessionTailRepin(shouldRun: () => boolean, run: () => void) {
  const shouldRunRef = useRef(shouldRun);
  shouldRunRef.current = shouldRun;
  const runRef = useRef(run);
  runRef.current = run;
  return useRef(
    createFrameCoalescer<null>(() => {
      if (shouldRunRef.current()) {
        runRef.current();
      }
    })
  ).current;
}
