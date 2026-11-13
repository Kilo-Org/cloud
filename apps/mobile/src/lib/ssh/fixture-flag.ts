import { useEffect, useState } from 'react';

let flagOn = false;
const flagListeners = new Set<() => void>();

export function setSshFixtureFlag(next: boolean): void {
  if (!__DEV__ || flagOn === next) {
    return;
  }
  flagOn = next;
  for (const listener of flagListeners) {
    listener();
  }
}

export function useSshFixtureFlag(): boolean {
  const [on, setOn] = useState(flagOn);
  useEffect(() => {
    if (!__DEV__) {
      return undefined;
    }
    const listener = () => {
      setOn(flagOn);
    };
    flagListeners.add(listener);
    return () => {
      flagListeners.delete(listener);
    };
  }, []);
  return __DEV__ && on;
}
