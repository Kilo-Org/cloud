import { AccessibilityInfo, Alert, Linking, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
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
import { isGatewayTranscriptionEnabled } from './gateway/gateway-transcription-preference';

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
  getLanguageTag?: () => string | null;
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

/**
 * One stable toast id for every voice-input message. sonner-native updates a
 * visible toast in place when a new toast carries the same id, so two errors
 * in a row never render as two stacked toasts whose copy overlaps. A
 * dismiss-then-add pair would animate both at once (the outgoing toast still
 * on screen as the new one lands), which is why the replacement rides the id,
 * not a dismiss.
 */
const VOICE_INPUT_TOAST_ID = 'voice-input-feedback';

export function showFeedback(feedback: VoiceInputFeedback): void {
  const presentation = resolveVoiceInputFeedbackPresentation(feedback);
  if (presentation.kind === 'alert') {
    // The alert is the message now; clear the toast channel with it.
    toast.dismiss(VOICE_INPUT_TOAST_ID);
    if (presentation.destination === 'transcription-model-picker') {
      Alert.alert(presentation.title, presentation.message, [
        { text: i18n.t('common.cancel'), style: 'cancel' },
        {
          text: i18n.t('transcriptionModel.title'),
          onPress: () => {
            router.push('/(app)/transcription-model-picker');
          },
        },
      ]);
      return;
    }
    Alert.alert(presentation.title, presentation.message, [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      { text: i18n.t('common.openSettings'), onPress: () => void Linking.openSettings() },
    ]);
    return;
  }
  // One stable toast id so a later message replaces an earlier one in place:
  // the user reads exactly one voice-input message at a time.
  toast.error(presentation.message, { id: VOICE_INPUT_TOAST_ID });
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
  const {
    controller,
    getDisabled,
    getDraft,
    getLanguageTag,
    getOnDraftChange,
    getOwner,
    getUserId,
  } = config;

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

    if (view.isActive && snapshot.status === 'transcribing') {
      // The upload can hang; the tap cancels it instead of starting a new one.
      await controller.abort(owner);
      return;
    }

    if (view.isActive && snapshot.status === 'listening') {
      void fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
      await controller.stop(owner);
      return;
    }

    if (view.isActive) {
      return;
    }

    const chosen = getLanguageTag?.() ?? null;
    const languageTag = chosen ?? (await resolveVoiceInputStartLanguageTag(i18n.language));

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

    if (isGatewayTranscriptionEnabled()) {
      // Gateway mode: the switch itself is the consent to send the recording
      // to the Kilo gateway, so no OS network-recognition disclosure applies.
      // The chosen model is resolved by the engine (the stored choice, else
      // the first model the gateway catalogue offers).
      await startWith(false);
      return;
    }

    // Device mode: the OS recogniser runs, so the consent flow below decides
    // the recognition mode.
    const supportsOnDeviceByService = controller.supportsOnDevice();
    const userId = getUserId();
    const consent = userId ? await readVoiceNetworkConsent(userId) : 'unset';
    // The service-level check alone is not enough: on-device recognition also
    // needs the offline model for the resolved language. `requiresOnDeviceRecognition`
    // without it fails on every attempt (`language-not-supported`) — that is
    // the German-locale bug — so the mode gate refines the service check with
    // the per-language installation state.
    const supportsOnDevice =
      supportsOnDeviceByService && (await isVoiceInputLanguageInstalledOnDevice(languageTag));
    const mode = resolveVoiceInputRecognitionMode(supportsOnDevice, consent);

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
        // transcription, so do not re-raise that disclosure. Only a service
        // that distinguishes supported from installed locales reaches this
        // branch, and on iOS every supported locale reports as installed, so
        // Android is the only platform that gets here in practice; the
        // remediation below triggers the Android-only
        // `androidTriggerOfflineModelDownload`, and if a service without that
        // capability ever reports a missing model, the download tap degrades
        // through the catch to the same actionable toast.
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
