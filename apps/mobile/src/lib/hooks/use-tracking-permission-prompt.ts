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

/**
 * App Tracking Transparency exists only on iOS. The pre-prompt, its failure
 * alert and the retry all belong to that platform, so one guard names it once
 * and the effect reads the guard instead of the platform.
 */
const isTrackingPermissionSupported = Platform.OS === 'ios';

export function useTrackingPermissionPrompt(enabled: boolean): void {
  useEffect(() => {
    let cancelled = false;

    if (enabled && isTrackingPermissionSupported) {
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

        // One request path for Continue and Retry. A native alert dismisses
        // synchronously on a button press, so one alert cannot start two
        // requests and a retry is user-driven: no extra admission guard.
        const requestPermission = async (): Promise<void> => {
          if (cancelled) {
            return;
          }

          try {
            await requestTrackingPermissionsAsync();
          } catch (error) {
            Sentry.captureException(error, {
              tags: {
                'error.subsystem': 'tracking_permission',
                'error.operation': 'request_permission',
              },
            });
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- the effect cleanup sets `cancelled` after this request settles
            if (cancelled) {
              return;
            }
            // The system prompt owns the outcome, so a failure only offers a
            // retry: nothing here records the dismissal.
            Alert.alert(
              i18n.t('consent.installAttributionRequestFailedTitle'),
              i18n.t('consent.installAttributionRequestFailedMessage'),
              [
                { text: i18n.t('common.cancel'), style: 'cancel' },
                {
                  text: i18n.t('common.retry'),
                  onPress: () => {
                    void requestPermission();
                  },
                },
              ],
              { cancelable: true }
            );
          }
        };

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
                void requestPermission();
              },
            },
          ],
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
