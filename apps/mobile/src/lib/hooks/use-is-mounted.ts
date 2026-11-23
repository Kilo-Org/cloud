import { type RefObject, useEffect, useRef } from 'react';

/**
 * Whether the calling component is still mounted, for a result that settles
 * after it may have closed.
 *
 * A request that lands after the surface unmounted has nowhere to show its
 * refusal, so the owner reads this ref at settle time and reports through a
 * channel that outlives the component.
 *
 * The effect arms the flag in its body, not only in its cleanup: a development
 * StrictMode replay runs setup, cleanup, then setup again, and a flag that was
 * only cleared would stay false for the component's whole life.
 */
export function useIsMounted(): RefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
