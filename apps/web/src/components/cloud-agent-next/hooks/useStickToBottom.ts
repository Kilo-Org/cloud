import { useLayoutEffect, useRef, type RefObject } from 'react';

const STICK_THRESHOLD_PX = 24;

/**
 * Keeps a scrollable element pinned to its bottom as `content` grows, but
 * only while the user is already at (or near) the bottom — scrolling up
 * releases the pin, scrolling back near the bottom re-engages it.
 */
export function useStickToBottom<T extends HTMLElement>(
  content: unknown
): { ref: RefObject<T | null>; onScroll: () => void } {
  const ref = useRef<T>(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  return { ref, onScroll };
}
