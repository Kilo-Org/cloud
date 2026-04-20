import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { addEventListener } from '@react-native-community/netinfo';

export function useAppLifecycle() {
  const [isActive, setIsActive] = useState(true);
  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      setIsActive(nextState === 'active');
    });
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = addEventListener(state => {
      setIsConnected(state.isInternetReachable ?? state.isConnected ?? true);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return { isActive, isConnected };
}
