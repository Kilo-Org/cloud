import * as Sentry from '@sentry/react-native';
import { requestTrackingPermissionsAsync } from 'expo-tracking-transparency';
import { useEffect } from 'react';
import { Platform } from 'react-native';

export function useTrackingPermissionPrompt(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || Platform.OS !== 'ios') {
      return;
    }

    async function requestPermission() {
      try {
        await requestTrackingPermissionsAsync();
      } catch (error) {
        Sentry.captureException(error);
      }
    }

    void requestPermission();
  }, [enabled]);
}
