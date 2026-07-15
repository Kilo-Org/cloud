import { AccessibilityInfo, Alert, Linking } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getLocales } from 'expo-localization';
import { toast } from 'sonner-native';

import {
  type VoiceInputControllerSnapshot,
  type VoiceInputStartOptions,
} from './voice-input-controller';
import {
  resolveVoiceInputFeedbackPresentation,
  shouldAnnounceListeningTransition,
} from './voice-input-feedback';
import { resolveVoiceInputLanguageTag } from './voice-input-language';
import {
  shouldAbortVoiceInput,
  type VoiceInputFeedback,
  type VoiceInputLifecycleInput,
  type VoiceInputStatus,
} from './voice-input-state';
import { resolveOwnerVoiceInputView } from './voice-input-view-state';

type VoiceInputControllerLike = {
  abort: (owner?: string) => Promise<boolean>;
  getSnapshot: () => VoiceInputControllerSnapshot;
  start: (options: VoiceInputStartOptions) => Promise<boolean>;
  stop: (owner: string) => Promise<boolean>;
  subscribe: (listener: (snapshot: VoiceInputControllerSnapshot) => void) => () => void;
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
  AccessibilityInfo.announceForAccessibility('Listening');
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
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open Settings', onPress: () => void Linking.openSettings() },
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
  const { controller, getDisabled, getDraft, getOnDraftChange, getOwner } = config;

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

    const startOptions: VoiceInputStartOptions = {
      baseDraft: getDraft(),
      languageTag: resolveVoiceInputLanguageTag(getLocales()),
      onDraftChange: getOnDraftChange(),
      onFeedback: showFeedback,
      owner,
    };
    await controller.start(startOptions);
  };

  return { abort, settleBeforeSubmit, toggle };
}
