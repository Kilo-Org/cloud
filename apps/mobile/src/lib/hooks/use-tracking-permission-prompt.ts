import * as Sentry from '@sentry/react-native';
import {
  getTrackingPermissionsAsync,
  PermissionStatus,
  requestTrackingPermissionsAsync,
} from 'expo-tracking-transparency';
import { useEffect } from 'react';
import { Alert, Platform } from 'react-native';

import { i18n } from '@/i18n';
import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { TRACKING_PROMPT_DISMISSED_KEY } from '@/lib/storage-keys';

/**
 * Remembers the user's "Not now" choice on the install-attribution pre-prompt.
 * Cleared on sign-out like the other prompt/consent flags, so the next signed-in
 * account gets a fresh decision.
 */
const dismissedStore = createSecureStorePreference<boolean>({
  key: TRACKING_PROMPT_DISMISSED_KEY,
  defaultValue: false,
  parse: raw => raw === 'true',
  serialize: value => (value ? 'true' : 'false'),
});

/** Reset the remembered "Not now" choice (sign-out teardown). */
export function clearTrackingPromptDismissed(): void {
  dismissedStore.clear();
}

export function useTrackingPermissionPrompt(enabled: boolean): void {
  useEffect(() => {
    let cancelled = false;

    if (!enabled || Platform.OS !== 'ios') {
      // No-op cleanup so every branch returns the same type.
    } else {
      const checkAndPrompt = async () => {
        // The remembered choice loads asynchronously from SecureStore: wait for
        // that read before deciding, so a fast ATT check can never show the
        // alert before the dismissal lands. Only the flag gates here; the
        // cancellation checks below stay independent so narrowing cannot
        // mark them unreachable.
        await dismissedStore.whenLoaded();
        if (dismissedStore.get()) {
          return;
        }

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
            {
              text: i18n.t('common.notNow'),
              style: 'cancel',
              onPress: () => {
                dismissedStore.set(true);
              },
            },
            {
              text: i18n.t('common.continue'),
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
          ],
          // Android back dismisses, which equals Not now: no request fires
          // and the prompt stays governed by its own re-ask policy.
          { cancelable: true }
        );
      };

      void checkAndPrompt();
    }

    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
