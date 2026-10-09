import { Platform } from 'react-native';

import { BackendInputError } from './backend-store';

/** Release Android keeps the OS cleartext ban even for approved LAN endpoints. */
export function assertBackendTransport(baseUrl: string): void {
  if (Platform.OS === 'android' && !__DEV__ && /^http:/iu.test(baseUrl.trim())) {
    throw new BackendInputError('httpReleaseUnavailable');
  }
}
