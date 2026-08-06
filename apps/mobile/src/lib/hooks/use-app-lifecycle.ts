import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useAppLifecycle() {
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      setIsActive(nextState === 'active');
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return { isActive };
}
