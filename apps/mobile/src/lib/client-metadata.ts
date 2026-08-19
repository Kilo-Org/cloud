import * as Application from 'expo-application';
import { Platform } from 'react-native';

/**
 * Client metadata headers sent on every mobile request so the server can
 * enforce the force-update policy. Kept out of `auth-header.ts` because that
 * module is pure (no native imports) and several unit suites depend on it.
 */
export function buildClientMetadataHeaders(): Record<string, string> {
  return {
    'x-kilo-client': 'mobile',
    'x-kilo-app-platform': Platform.OS === 'ios' ? 'ios' : 'android',
    'x-kilo-app-version': Application.nativeApplicationVersion ?? '',
  };
}
