import * as Sentry from '@sentry/react-native';
import {
  getTrackingPermissionsAsync,
  PermissionStatus,
  requestTrackingPermissionsAsync,
} from 'expo-tracking-transparency';
import { useEffect } from 'react';
import { Alert, Platform } from 'react-native';

export function useTrackingPermissionPrompt(enabled: boolean): void {
  useEffect(() => {
    let cancelled = false;

    if (!enabled || Platform.OS !== 'ios') {
      // No-op cleanup so every branch returns the same type.
    } else {
      const checkAndPrompt = async () => {
        let currentStatus: PermissionStatus | undefined = undefined;
        try {
          const response = await getTrackingPermissionsAsync();
          if (cancelled) {
            return;
          }
          currentStatus = response.status;
        } catch (error) {
          if (cancelled) {
            return;
          }
          Sentry.captureException(error);
          return;
        }

        if (currentStatus !== PermissionStatus.UNDETERMINED) {
          return;
        }

        Alert.alert(
          'Allow install attribution?',
          "Kilo uses Apple's tracking permission only to learn which channel brought you here. Your prompts and conversations are never used.",
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Continue',
              onPress: () => {
                void (async () => {
                  try {
                    await requestTrackingPermissionsAsync();
                  } catch (error) {
                    Sentry.captureException(error);
                  }
                })();
              },
            },
          ]
        );
      };

      void checkAndPrompt();
    }

    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
