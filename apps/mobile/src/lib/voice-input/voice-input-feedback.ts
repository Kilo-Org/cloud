import { i18n } from '@/i18n';

import { type VoiceInputFeedback, type VoiceInputStatus } from './voice-input-state';

export type VoiceInputFeedbackPresentation =
  | {
      kind: 'alert';
      title: string;
      message: string;
      /** Where the alert's action button leads. */
      destination: 'system-settings' | 'transcription-model-picker';
    }
  | { kind: 'toast'; message: string; tone?: 'error' | 'info' };

/**
 * Pure projection of a `VoiceInputFeedback` into the surface that should
 * display it. Feedback with a follow-up destination gets a native alert with
 * a Cancel affordance plus a button that opens that destination: permanent
 * microphone denial opens the system settings, a gateway transcription
 * problem that needs a different model opens the transcription model picker.
 * Every other case is a transient toast — retryable failures invite the user
 * to try again, non-retryable ones are informational only. Keeping this
 * decision in a pure function makes the policy unit-testable and isolates
 * React Native's `Alert` and `toast` from the rule.
 */
export function resolveVoiceInputFeedbackPresentation(
  feedback: VoiceInputFeedback
): VoiceInputFeedbackPresentation {
  if (feedback.action === 'open-transcription-settings') {
    return {
      kind: 'alert',
      title: i18n.t('transcriptionModel.title'),
      message: feedback.message,
      destination: 'transcription-model-picker',
    };
  }
  if (feedback.action === 'open-settings') {
    return {
      kind: 'alert',
      title: i18n.t('voiceInput.micOffTitle'),
      message: feedback.message,
      destination: 'system-settings',
    };
  }
  return { kind: 'toast', message: feedback.message, tone: feedback.tone };
}

/**
 * Pure decision for whether the listening-announce + light haptic should
 * fire. The only signal we care about is the owner-relative status flipping
 * from any non-listening state into `listening` — every other transition
 * (including a re-render that keeps the same `listening` state, a status
 * flip that doesn't belong to us, or a transition to `starting` /
 * `stopping` / `idle`) returns `false`. The hook calls this each render and
 * only fires the side effects on a `true` result.
 */
export function shouldAnnounceListeningTransition(
  previousOwnStatus: VoiceInputStatus | null,
  nextOwnStatus: VoiceInputStatus
): boolean {
  return previousOwnStatus !== 'listening' && nextOwnStatus === 'listening';
}
