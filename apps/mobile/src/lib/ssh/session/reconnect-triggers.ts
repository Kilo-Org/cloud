import { addEventListener } from '@react-native-community/netinfo';
import { AppState } from 'react-native';

import { resumeSshSessions } from './manager';

/**
 * Nudges a session that is waiting to reconnect as soon as trying again can
 * work: the app came back to the foreground, or the network returned. Both
 * listeners only act on sessions already in their retry window, so an
 * established connection is never disturbed.
 */
export function startSshReconnectTriggers(): () => void {
  let wasActive = AppState.currentState === 'active';
  const appState = AppState.addEventListener('change', state => {
    const active = state === 'active';
    if (active && !wasActive) {
      resumeSshSessions();
    }
    wasActive = active;
  });
  const unsubscribeNetwork = addEventListener(state => {
    if (state.isConnected === true) {
      resumeSshSessions();
    }
  });
  return () => {
    appState.remove();
    unsubscribeNetwork();
  };
}
