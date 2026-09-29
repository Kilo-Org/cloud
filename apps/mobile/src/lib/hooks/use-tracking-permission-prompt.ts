import * as Sentry from '@sentry/react-native';
import {
  getTrackingPermissionsAsync,
  PermissionStatus,
  requestTrackingPermissionsAsync,
} from 'expo-tracking-transparency';
import { useEffect } from 'react';
import { Alert, Platform } from 'react-native';

import { i18n } from '@/i18n';
import {
  markInstallAttributionPromptSeen,
  readInstallAttributionPromptSeen,
  whenInstallAttributionPromptSeenLoaded,
} from '@/lib/hooks/install-attribution-prompt-preference';

export function useTrackingPermissionPrompt(enabled: boolean): void {
  useEffect(() => {
    let cancelled = false;
    // Read through a call so the post-await checks are not narrowed away by
    // the earlier guard: the cleanup can flip `cancelled` while a promise is
    // in flight.
    const isCancelled = () => cancelled;

    if (!enabled || Platform.OS !== 'ios') {
      // No-op cleanup so every branch returns the same type.
    } else {
      const checkAndPrompt = async () => {
        // A soft "Not now" leaves the native authorization `undetermined`, so
        // the persisted answer is the only thing that stops the explainer
        // reappearing on the next cold launch.
        await whenInstallAttributionPromptSeenLoaded();
        if (isCancelled() || readInstallAttributionPromptSeen()) {
          return;
        }

        let currentStatus: PermissionStatus | undefined = undefined;
        try {
          const response = await getTrackingPermissionsAsync();
          if (isCancelled()) {
            return;
          }
          currentStatus = response.status;
        } catch (error) {
          if (isCancelled()) {
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
            {
              text: i18n.t('common.notNow'),
              style: 'cancel',
              onPress: () => {
                markInstallAttributionPromptSeen();
              },
            },
            {
              text: i18n.t('common.continue'),
              onPress: () => {
                markInstallAttributionPromptSeen();
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
