import { type NetInfoState } from '@react-native-community/netinfo';

export type ConnectivityState = Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>;

export type ConnectivityStatus = 'online' | 'offline' | 'unknown';

/**
 * Three-way connectivity classification. NetInfo reports `null` for both
 * fields while it boots, so a `null` reachability must not be read as online
 * (the old `isOnline` defaulted to `true` and rendered an unknown boot as
 * live data). Only a definite reachability answer is authoritative; a null
 * one falls back to the definite connection state: offline when the device
 * is surely disconnected, otherwise unknown.
 */
export function connectivityStatus(state: ConnectivityState): ConnectivityStatus {
  const { isConnected, isInternetReachable } = state;
  if (isInternetReachable === true) {
    return 'online';
  }
  if (isInternetReachable === false) {
    return 'offline';
  }
  return isConnected === false ? 'offline' : 'unknown';
}

/** True only for a confirmed online state; `unknown` is never online. */
export function isOnline(state: ConnectivityState): boolean {
  return connectivityStatus(state) === 'online';
}
