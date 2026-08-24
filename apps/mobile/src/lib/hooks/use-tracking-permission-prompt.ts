import * as Sentry from '@sentry/react-native';
import {
  getTrackingPermissionsAsync,
  PermissionStatus,
  requestTrackingPermissionsAsync,
} from 'expo-tracking-transparency';
import { useEffect } from 'react';
import { Alert, Platform } from 'react-native';

import { i18n } from '@/i18n';

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
          Sentry.captureException(error, {
            tags: {
              'error.subsystem': 'tracking_permission',
              'error.operation': 'get_permission',
            },
          });
          return;
        }

        if (currentStatus !== PermissionStatus.UNDETERMINED) {
          return;
        }

        Alert.alert(
          i18n.t('consent.installAttributionPromptTitle'),
          i18n.t('consent.installAttributionPromptMessage'),
          [
            { text: i18n.t('common.notNow'), style: 'cancel' },
            {
              text: i18n.t('consent.continue'),
              onPress: () => {
                void (async () => {
                  try {
                    await requestTrackingPermissionsAsync();
                  } catch (error) {
                    Sentry.captureException(error, {
                      tags: {
                        'error.subsystem': 'tracking_permission',
                        'error.operation': 'request_permission',
                      },
                    });
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
