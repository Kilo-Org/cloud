import { useEffect, useRef } from 'react';

/**
 * Owns a resource for the lifetime of the mounting component.
 *
 * `create` runs once, ref-cached on the first render, and the returned
 * resource survives every re-render. The cleanup effect defers `destroy` by
 * a zero-delay timer that closes over the instance it owns, so a replayed
 * effect (StrictMode development double-mount) cancels the pending destroy
 * in the same tick and keeps one live resource; only a real unmount lets
 * the deferred destroy fire. After it fires the ref is cleared, so a fresh
 * mount recreates the resource.
 *
 * The hook has no dependency-driven recreation: changing the create inputs
 * requires a `key` change on the component so React remounts it.
 *
 * Accepted residual, identical to the previous `ref.current ??= create()`
 * pattern: a render abandoned before commit can leak one instance that the
 * effect never retains and therefore never destroys.
 */
export function useOwnedResource<T>(create: () => T, destroy: (resource: T) => void): T {
  const createRef = useRef(create);
  const destroyRef = useRef(destroy);
  createRef.current = create;
  destroyRef.current = destroy;

  const ownedRef = useRef<T | null>(null);
  ownedRef.current ??= createRef.current();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // An effect replay in the same tick cancels the deferred destroy the
    // previous cleanup scheduled, preserving the same resource.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      const owned = ownedRef.current;
      if (owned === null) {
        return;
      }
      // Defer the destroy by a zero-delay timer that closes over THIS
      // owned instance. The fire time never reads the ref, so a newer
      // generation's resource can never be destroyed by an old timer.
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (ownedRef.current === owned) {
          ownedRef.current = null;
        }
        destroyRef.current(owned);
      }, 0);
    };
  }, []);

  return ownedRef.current;
}
