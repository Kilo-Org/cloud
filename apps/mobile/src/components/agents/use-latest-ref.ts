import { useEffect, useRef } from 'react';

/**
 * A ref that always holds the latest render's value, updated in an effect.
 * `onStart` reads the route's press-time inputs through refs so its callback
 * stays stable across renders while always seeing the latest values.
 */
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
