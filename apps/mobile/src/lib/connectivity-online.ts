import { type NetInfoState } from '@react-native-community/netinfo';

export type ConnectivityState = Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>;

export function isOnline(state: ConnectivityState): boolean {
  return state.isInternetReachable ?? state.isConnected ?? true;
}
