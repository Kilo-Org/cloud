import { type VoiceInputControllerSnapshot } from './voice-input-controller';
import { type VoiceInputStatus } from './voice-input-state';

/**
 * The per-owner projection of the shared voice-input controller snapshot.
 * Owners (e.g. specific composer instances) use this to decide whether the
 * voice session currently belongs to them and which status to render.
 */
type OwnerVoiceInputView = {
  available: boolean;
  isActive: boolean;
  status: VoiceInputStatus;
};

/**
 * Pure projection of a shared `VoiceInputControllerSnapshot` for a single
 * owner. The owner is active only when the snapshot's `owner` matches the
 * caller's `owner`; otherwise the view collapses to an idle, inactive state
 * while still reporting the controller-wide availability. This keeps each
 * composer's voice button honest about whether *its* session is in progress,
 * even if a different owner has taken over the controller.
 */
export function resolveOwnerVoiceInputView(
  snapshot: VoiceInputControllerSnapshot,
  owner: string
): OwnerVoiceInputView {
  const isActive = snapshot.owner === owner;
  return {
    available: snapshot.availability === 'available',
    isActive,
    status: isActive ? snapshot.status : 'idle',
  };
}

export type VoiceInputControlIcon = 'microphone' | 'stop';
export type VoiceInputAccessibilityLabel = 'Start voice input' | 'Stop voice input';

export type VoiceInputControlState = {
  accessibilityLabel: VoiceInputAccessibilityLabel;
  busy: boolean;
  disabled: boolean;
  icon: VoiceInputControlIcon;
  showListeningStatus: boolean;
};

/**
 * Pure derivation of the voice-input control's presentation from the
 * controller's `status` and an external `disabled` flag (e.g. composer is
 * read-only). The `busy` flag follows the starting/stopping transitions so
 * a press during teardown is ignored; the `disabled` flag is the union of
 * that busy state and the external disabled flag. While listening, the
 * button shows a stop affordance and surfaces the "Listening..." status
 * string for screen readers and the visible row beneath the composer.
 */
export function resolveVoiceInputControlState(
  status: VoiceInputStatus,
  disabled: boolean
): VoiceInputControlState {
  switch (status) {
    case 'starting': {
      return {
        accessibilityLabel: 'Start voice input',
        busy: true,
        disabled: true,
        icon: 'microphone',
        showListeningStatus: false,
      };
    }
    case 'listening': {
      return {
        accessibilityLabel: 'Stop voice input',
        busy: false,
        disabled,
        icon: 'stop',
        showListeningStatus: true,
      };
    }
    case 'stopping': {
      return {
        accessibilityLabel: 'Stop voice input',
        busy: true,
        disabled: true,
        icon: 'stop',
        showListeningStatus: false,
      };
    }
    case 'idle': {
      return {
        accessibilityLabel: 'Start voice input',
        busy: false,
        disabled,
        icon: 'microphone',
        showListeningStatus: false,
      };
    }
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled VoiceInputStatus: ${String(unhandled)}`);
    }
  }
}
