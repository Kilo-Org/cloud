import { AccessibilityInfo, Alert, Linking, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
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
import { resolveVoiceInputStartLanguageTag } from './voice-input-language';
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

    const supportsOnDevice = controller.supportsOnDevice();
    const userId = getUserId();
    const consent = userId ? await readVoiceNetworkConsent(userId) : 'unset';
    const mode = resolveVoiceInputRecognitionMode(supportsOnDevice, consent);

    const startWith = async (requiresOnDeviceRecognition: boolean): Promise<void> => {
      const startOptions: VoiceInputStartOptions = {
        baseDraft: getDraft(),
        languageTag: await resolveVoiceInputStartLanguageTag(i18n.language),
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
