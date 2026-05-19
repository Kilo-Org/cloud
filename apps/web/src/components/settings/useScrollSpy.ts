'use client';

import { useState, useEffect, useRef, useMemo } from 'react';

/**
 * Scrollspy hook for settings pages. Tracks which section is currently
 * closest to the top of the scroll viewport and exposes a `scrollTo`
 * helper for nav clicks.
 *
 * Pass `scrollRootId` when the settings content lives inside a nested
 * scroll container (e.g. a parent layout wraps it in `overflow-hidden`).
 * When omitted, the hook uses the window viewport — matching the
 * gastown settings pattern where the layout doesn't force overflow.
 *
 * `stickyHeaderId` points at a sticky top bar; we read its height at
 * click time to offset the scroll destination so the target section
 * doesn't land underneath it. IntersectionObserver's rootMargin uses
 * the same value so the spy activates sections as they emerge from
 * behind the sticky header.
 */
export function useScrollSpy(
  sectionIds: readonly string[],
  options: { scrollRootId?: string; stickyHeaderId?: string } = {}
) {
  const { scrollRootId, stickyHeaderId } = options;
  const [activeId, setActiveId] = useState<string>(sectionIds[0] ?? '');
  const suppressRef = useRef(false);
  // Tracked so the re-enable timer can be cleared on unmount — otherwise
  // a pending timer fires after the component is gone and calls
  // suppressRef.current = false on a ref that no one reads any more.
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dedupe / stabilize the section-id list so the observer isn't torn
  // down on every render just because the caller passed `foo.map(...)`.
  const idsKey = sectionIds.join('|');
  const stableIds = useMemo(() => sectionIds.slice(), [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const root = scrollRootId ? document.getElementById(scrollRootId) : null;
    const header = stickyHeaderId ? document.getElementById(stickyHeaderId) : null;
    // Measure the sticky header once at setup so the observer's topMargin
    // matches what scrollTo uses. When there's no sticky header in the
    // scroll viewport, use 0 — the viewport top IS where sections land.
    const headerHeight = stickyHeaderId ? (header?.offsetHeight ?? 56) : 0;

    const observer = new IntersectionObserver(
      entries => {
        if (suppressRef.current) return;
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { root, rootMargin: `-${headerHeight}px 0px -60% 0px`, threshold: 0 }
    );

    for (const id of stableIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => {
      observer.disconnect();
      if (suppressTimerRef.current !== null) {
        clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = null;
      }
    };
  }, [stableIds, scrollRootId, stickyHeaderId]);

  function scrollTo(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    // Resolve the scroll root up front so we can bail BEFORE suppressing
    // the observer — otherwise a missing root would exit with suppressRef
    // left `true` forever and the spy would stop updating until remount.
    const root = scrollRootId ? document.getElementById(scrollRootId) : null;
    if (scrollRootId && !root) return;

    // Resolve the header fresh each click so late-mounting content
    // (e.g. an AdminViewingBanner) can't leave us with a stale 0.
    const header = stickyHeaderId ? document.getElementById(stickyHeaderId) : null;
    const headerHeight = header?.offsetHeight ?? 0;

    setActiveId(id);
    suppressRef.current = true;

    if (root) {
      const top =
        el.getBoundingClientRect().top -
        root.getBoundingClientRect().top +
        root.scrollTop -
        headerHeight -
        24;
      root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else {
      const top = el.getBoundingClientRect().top + window.scrollY - headerHeight - 24;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    // Re-enable observer after scroll settles so it doesn't thrash the
    // active indicator on the way there. Track the timer id so the
    // unmount cleanup can cancel a pending re-enable.
    if (suppressTimerRef.current !== null) {
      clearTimeout(suppressTimerRef.current);
    }
    suppressTimerRef.current = setTimeout(() => {
      suppressRef.current = false;
      suppressTimerRef.current = null;
    }, 1000);
  }

  return { activeId, scrollTo };
}
