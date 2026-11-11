import { useEffect, useRef } from 'react';

import { createFrameCoalescer } from '@/lib/coalesce-frame';

/**
 * One tail correction per animation frame, however many layout or content-size
 * events ask for it.
 *
 * A keyboard slide reports several layout passes, and the composer beside the
 * transcript changes the content height in the same frame; correcting each of
 * those events hard-scrolls the list several times per frame. The guards are
 * re-read when the frame runs, so a drag or a scroll away that lands in between
 * still wins, and an unmounted list publishes nothing.
 *
 * The coalescer is created once and never cancelled: `createFrameCoalescer`
 * treats a cancel as permanent, so cancelling it on unmount would leave a
 * remounted list (or React's strict double-invoked effect) unable to follow the
 * tail again. The published guard checks liveness instead.
 */
export function useSessionTailRepin(shouldRun: () => boolean, run: () => void) {
  const shouldRunRef = useRef(shouldRun);
  shouldRunRef.current = shouldRun;
  const runRef = useRef(run);
  runRef.current = run;
  const aliveRef = useRef(false);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  return useRef(
    createFrameCoalescer<null>(() => {
      if (aliveRef.current && shouldRunRef.current()) {
        runRef.current();
      }
    })
  ).current;
}
