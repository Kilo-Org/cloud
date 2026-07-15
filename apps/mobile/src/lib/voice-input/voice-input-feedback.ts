import { type VoiceInputFeedback, type VoiceInputStatus } from './voice-input-state';

export type VoiceInputFeedbackPresentation =
  | { kind: 'alert'; title: 'Microphone access is off'; message: string }
  | { kind: 'toast'; message: string };

const ALERT_TITLE = 'Microphone access is off' as const;

/**
 * Pure projection of a `VoiceInputFeedback` into the surface that should
 * display it. Open-settings feedback (permanent microphone denial) gets a
 * native alert with a Cancel/Open Settings affordance so the user can
 * recover without re-trying the gesture. Every other case is a transient
 * toast — retryable failures invite the user to try again, non-retryable
 * ones are informational only. Keeping this decision in a pure function
 * makes the policy unit-testable and isolates React Native's `Alert` and
 * `toast` from the rule.
 */
export function resolveVoiceInputFeedbackPresentation(
  feedback: VoiceInputFeedback
): VoiceInputFeedbackPresentation {
  if (feedback.action === 'open-settings') {
    return { kind: 'alert', title: ALERT_TITLE, message: feedback.message };
  }
  return { kind: 'toast', message: feedback.message };
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
