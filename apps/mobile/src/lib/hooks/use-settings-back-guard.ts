import { getSettingsBackGuardOptions } from '@kilocode/app-shared/security-agent';
import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, type AlertButton } from 'react-native';

import { i18n } from '@/i18n';
import { usePreventRemove } from '@/lib/navigation/prevent-remove';
import { getSecurityAgentPath } from '@/lib/security-agent';

const BUTTON_LABEL_KEY = {
  save: 'securityAgent.settingsSave.saveChanges',
  discard: 'securityAgent.settingsSave.discard',
  'keep-editing': 'securityAgent.settingsSave.keepEditing',
} as const;

/**
 * Bounces off a Security Agent settings screen once its config has loaded
 * and `isEnabled` is false. A config save never re-enables the agent on its
 * own, so these screens shouldn't stay reachable while disabled — only the
 * overview screen (`getSecurityAgentPath(scope, 'settings')`) can turn
 * enablement back on.
 *
 * The repositories screen is the one exception: a disabled agent with
 * integration repos but no effective selection must stay reachable so the
 * user can pick repos and then enable. Pass `skipRedirect` to opt that screen
 * out of the bounce.
 */
export function useSecurityAgentSettingsRedirect(
  scope: string,
  isEnabled: boolean | undefined,
  skipRedirect = false
) {
  const router = useRouter();
  useEffect(() => {
    if (isEnabled === false && !skipRedirect) {
      router.replace(getSecurityAgentPath(scope, 'settings'));
    }
  }, [isEnabled, router, scope, skipRedirect]);
}

/**
 * Shared dirty-screen back handling for Security Agent settings screens.
 * Registers a predictive-Back-safe guard via `usePreventRemove`, which
 * fires for every way a screen can be removed — header back, Android
 * hardware back, and the iOS swipe-back gesture — so all three paths get
 * the same confirmation instead of only the header button.
 *
 * Not a general form framework: it only classifies dirty/valid into an
 * alert with up to three buttons and replays the captured navigation
 * action once the user has resolved it.
 */
export function useSettingsBackGuard({
  dirty,
  valid,
  onSave,
}: Readonly<{
  dirty: boolean;
  valid: boolean;
  onSave: () => Promise<void>;
}>) {
  const navigation = useNavigation();
  // Keep the latest onSave in a ref so the callback below doesn't depend on it
  // directly — onSave is a fresh closure every render. usePreventRemove keeps
  // the callback itself fresh via useLatestCallback, but the ref keeps onSave
  // stable without re-registering.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Set by SettingsSaveButton right before it calls `router.back()` after a
  // successful header-Save. `dirty` won't flip to false until this screen
  // re-hydrates from a refetched query — which hasn't happened yet at that
  // point — so without this bypass the back navigation the Save button
  // itself triggers gets intercepted as if it were an unconfirmed exit,
  // popping a spurious "Unsaved changes" alert whose own Save button would
  // save a second time.
  const skipNextGuardRef = useRef(false);

  usePreventRemove(dirty, ({ data }) => {
    if (skipNextGuardRef.current) {
      skipNextGuardRef.current = false;
      navigation.dispatch(data.action);
      return;
    }
    const action = data.action;
    const options = getSettingsBackGuardOptions(valid ? 'dirty-valid' : 'dirty-invalid');
    const buttons: AlertButton[] = options.map(option => {
      if (option === 'keep-editing') {
        return { text: i18n.t(BUTTON_LABEL_KEY[option]), style: 'cancel' };
      }
      if (option === 'discard') {
        return {
          text: i18n.t(BUTTON_LABEL_KEY[option]),
          style: 'destructive',
          onPress: () => {
            navigation.dispatch(action);
          },
        };
      }
      return {
        text: i18n.t(BUTTON_LABEL_KEY[option]),
        onPress: () => {
          void (async () => {
            try {
              await onSaveRef.current();
              navigation.dispatch(action);
            } catch {
              // The save mutation's centralized onError already toasted —
              // stay on the screen so the user can retry or discard.
            }
          })();
        },
      };
    });
    Alert.alert(
      i18n.t('securityAgent.settingsSave.unsavedTitle'),
      i18n.t('securityAgent.settingsSave.unsavedMessage'),
      buttons
    );
  });

  return {
    onBack: () => {
      navigation.goBack();
    },
    skipNextGuardRef,
  };
}
