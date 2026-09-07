import { AccessibilityInfo, Alert, Linking, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

import {
  type VoiceInputControllerSnapshot,
  type VoiceInputStartOptions,
} from './voice-input-controller';
import {
  resolveVoiceInputFeedbackPresentation,
  shouldAnnounceListeningTransition,
} from './voice-input-feedback';
import {
  invalidateVoiceRecognitionLocalesCache,
  isVoiceInputLanguageInstalledOnDevice,
  resolveVoiceInputStartLanguageTag,
  voiceInputLanguageDisplayName,
} from './voice-input-language';
import {
  shouldAbortVoiceInput,
  type VoiceInputFeedback,
  type VoiceInputLifecycleInput,
  type VoiceInputStatus,
} from './voice-input-state';
import { resolveVoiceInputRecognitionMode } from './voice-input-recognition-mode';
import { readVoiceNetworkConsent, writeVoiceNetworkConsent } from './voice-network-consent';
import { resolveOwnerVoiceInputView } from './voice-input-view-state';

type VoiceInputControllerLike = {
  abort: (owner?: string) => Promise<boolean>;
  getSnapshot: () => VoiceInputControllerSnapshot;
  start: (options: VoiceInputStartOptions) => Promise<boolean>;
  stop: (owner: string) => Promise<boolean>;
  subscribe: (listener: (snapshot: VoiceInputControllerSnapshot) => void) => () => void;
  supportsOnDevice: () => boolean;
};

export type VoiceInputActions = {
  abort: () => Promise<boolean>;
  settleBeforeSubmit: () => Promise<boolean>;
  toggle: () => Promise<void>;
};

type VoiceInputActionsConfig = {
  controller: VoiceInputControllerLike;
  getDisabled: () => boolean;
  getDraft: () => string;
  getOnDraftChange: () => (draft: string) => void;
  getOwner: () => string;
  getUserId: () => string | undefined;
};

async function fireHaptic(style: Haptics.ImpactFeedbackStyle): Promise<void> {
  try {
    await Haptics.impactAsync(style);
  } catch {
    // Haptic feedback is best-effort; never surface failures to the user.
  }
}

function announceVoiceInputListening(): void {
  void fireHaptic(Haptics.ImpactFeedbackStyle.Light);
  AccessibilityInfo.announceForAccessibility(i18n.t('voiceInput.listening'));
}

export function runVoiceInputListeningFeedback(
  previousOwnStatus: VoiceInputStatus | null,
  nextOwnStatus: VoiceInputStatus
): void {
  if (shouldAnnounceListeningTransition(previousOwnStatus, nextOwnStatus)) {
    announceVoiceInputListening();
  }
}

export function showFeedback(feedback: VoiceInputFeedback): void {
  const presentation = resolveVoiceInputFeedbackPresentation(feedback);
  if (presentation.kind === 'alert') {
    Alert.alert(presentation.title, presentation.message, [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      { text: i18n.t('common.openSettings'), onPress: () => void Linking.openSettings() },
    ]);
    return;
  }
  toast.error(presentation.message);
}

export function shouldAbortVoiceInputForOwner(
  snapshot: VoiceInputControllerSnapshot,
  owner: string,
  input: VoiceInputLifecycleInput
): boolean {
  const view = resolveOwnerVoiceInputView(snapshot, owner);
  return view.isActive && shouldAbortVoiceInput(input);
}

export function createVoiceInputActions(config: VoiceInputActionsConfig): VoiceInputActions {
  const { controller, getDisabled, getDraft, getOnDraftChange, getOwner, getUserId } = config;

  const abort = async (): Promise<boolean> => {
    const result = await controller.abort(getOwner());
    return result;
  };

  const settleBeforeSubmit = async (): Promise<boolean> => {
    const owner = getOwner();
    const result = await controller.stop(owner);
    return result;
  };

  const toggle = async (): Promise<void> => {
    if (getDisabled()) {
      return;
    }
    const owner = getOwner();
    const snapshot = controller.getSnapshot();
    const view = resolveOwnerVoiceInputView(snapshot, owner);

    if (view.isActive && snapshot.status === 'listening') {
      void fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
      await controller.stop(owner);
      return;
    }

    if (view.isActive) {
      return;
    }

    const supportsOnDeviceByService = controller.supportsOnDevice();
    const userId = getUserId();
    const consent = userId ? await readVoiceNetworkConsent(userId) : 'unset';
    const languageTag = await resolveVoiceInputStartLanguageTag(i18n.language);
    // The service-level check alone is not enough: on-device recognition also
    // needs the offline model for the resolved language. `requiresOnDeviceRecognition`
    // without it fails on every attempt (`language-not-supported`) — that is
    // the German-locale bug — so the mode gate refines the service check with
    // the per-language installation state.
    const supportsOnDevice =
      supportsOnDeviceByService && (await isVoiceInputLanguageInstalledOnDevice(languageTag));
    const mode = resolveVoiceInputRecognitionMode(supportsOnDevice, consent);

    const startWith = async (requiresOnDeviceRecognition: boolean): Promise<void> => {
      const startOptions: VoiceInputStartOptions = {
        baseDraft: getDraft(),
        languageTag,
        onDraftChange: getOnDraftChange(),
        onFeedback: showFeedback,
        owner,
        requiresOnDeviceRecognition,
      };
      await controller.start(startOptions);
    };

    if (mode === 'on-device') {
      await startWith(true);
      return;
    }
    if (mode === 'network') {
      await startWith(false);
      return;
    }
    // mode === 'blocked'
    if (consent === 'declined') {
      if (supportsOnDeviceByService) {
        // The device can recognize on-device, but the offline model for the
        // resolved language is missing. Say what is wrong and offer the
        // download instead of a bare error; the user declined network
        // transcription, so do not re-raise that disclosure.
        const languageName = voiceInputLanguageDisplayName(languageTag);
        Alert.alert(
          i18n.t('voiceInput.languageNotInstalledTitle', { language: languageName }),
          i18n.t('voiceInput.languageNotInstalledMessage', { language: languageName }),
          [
            { text: i18n.t('common.notNow'), style: 'cancel' },
            {
              text: i18n.t('voiceInput.downloadOfflineModel'),
              onPress: () => {
                void (async () => {
                  try {
                    const result =
                      await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({
                        locale: languageTag,
                      });
                    // The gate memoizes the installed-locale list; drop it so
                    // the next toggle re-queries the service instead of
                    // re-offering a download that already ran.
                    invalidateVoiceRecognitionLocalesCache();
                    if (result.status === 'download_scheduled') {
                      // A scheduled download is the accepted outcome of the
                      // user's tap, not a failure — render it as one.
                      toast.success(i18n.t('voiceInput.offlineModelDownloadScheduled'));
                    }
                  } catch {
                    invalidateVoiceRecognitionLocalesCache();
                    toast.error(i18n.t('voiceInput.unavailableLanguage'));
                  }
                })();
              },
            },
          ]
        );
        return;
      }
      toast.error(i18n.t('voiceInput.staysOff'));
      return;
    }
    // consent === 'unset' — raise the disclosure, do not start until answered.
    Alert.alert(
      i18n.t('voiceInput.onlineTitle'),
      i18n.t('voiceInput.onlineMessage', {
        provider: Platform.OS === 'ios' ? 'Apple' : 'Google',
      }),
      [
        {
          text: i18n.t('common.notNow'),
          style: 'cancel',
          onPress: () => {
            if (userId) {
              void writeVoiceNetworkConsent(userId, 'declined');
            }
          },
        },
        {
          text: i18n.t('voiceInput.allow'),
          onPress: () => {
            void (async () => {
              if (userId) {
                await writeVoiceNetworkConsent(userId, 'granted');
              }
              await startWith(false);
            })();
          },
        },
      ]
    );
  };

  return { abort, settleBeforeSubmit, toggle };
}
