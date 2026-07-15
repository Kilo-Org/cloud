import { describe, expect, it } from 'vitest';

import {
  resolveVoiceInputFeedbackPresentation,
  shouldAnnounceListeningTransition,
  type VoiceInputFeedbackPresentation,
} from './voice-input-feedback';
import { type VoiceInputFeedback, type VoiceInputStatus } from './voice-input-state';

function feedback(overrides: Partial<VoiceInputFeedback> = {}): VoiceInputFeedback {
  return {
    action: 'none',
    availability: 'available',
    message: 'Something went wrong.',
    retryable: true,
    ...overrides,
  };
}

describe('resolveVoiceInputFeedbackPresentation', () => {
  it('returns an alert with a fixed microphone-off title when the action is open-settings', () => {
    const presentation: VoiceInputFeedbackPresentation = resolveVoiceInputFeedbackPresentation(
      feedback({
        action: 'open-settings',
        message: 'Microphone access is off. Enable it in Settings to use voice input.',
        retryable: false,
      })
    );

    expect(presentation).toEqual({
      kind: 'alert',
      title: 'Microphone access is off',
      message: 'Microphone access is off. Enable it in Settings to use voice input.',
    });
  });

  it('returns a toast for a retryable feedback that has no follow-up action', () => {
    const presentation: VoiceInputFeedbackPresentation = resolveVoiceInputFeedbackPresentation(
      feedback({
        action: 'none',
        message: 'No speech detected. Tap the microphone to try again.',
        retryable: true,
      })
    );

    expect(presentation).toEqual({
      kind: 'toast',
      message: 'No speech detected. Tap the microphone to try again.',
    });
  });

  it('returns a toast for a non-retryable feedback that has no follow-up action', () => {
    const presentation: VoiceInputFeedbackPresentation = resolveVoiceInputFeedbackPresentation(
      feedback({
        action: 'none',
        availability: 'unavailable',
        message: "Voice input isn't available on this device.",
        retryable: false,
      })
    );

    expect(presentation).toEqual({
      kind: 'toast',
      message: "Voice input isn't available on this device.",
    });
  });
});

describe('shouldAnnounceListeningTransition', () => {
  const allStatuses: VoiceInputStatus[] = ['idle', 'starting', 'listening', 'stopping'];

  it('fires exactly once for the first transition into listening (null → listening)', () => {
    expect(shouldAnnounceListeningTransition(null, 'listening')).toBe(true);
  });

  it('fires on every other non-listening → listening transition (idle, starting, stopping)', () => {
    const nonListening: VoiceInputStatus[] = allStatuses.filter(
      (status): boolean => status !== 'listening'
    );
    for (const previous of nonListening) {
      expect(shouldAnnounceListeningTransition(previous, 'listening')).toBe(true);
    }
  });

  it('does not fire on a re-render that keeps the previous own status as listening', () => {
    expect(shouldAnnounceListeningTransition('listening', 'listening')).toBe(false);
  });

  it('does not fire on transitions away from listening', () => {
    expect(shouldAnnounceListeningTransition('listening', 'idle')).toBe(false);
    expect(shouldAnnounceListeningTransition('listening', 'stopping')).toBe(false);
    expect(shouldAnnounceListeningTransition('listening', 'starting')).toBe(false);
  });

  it('does not fire on transitions that never reach listening', () => {
    expect(shouldAnnounceListeningTransition('idle', 'starting')).toBe(false);
    expect(shouldAnnounceListeningTransition('starting', 'stopping')).toBe(false);
    expect(shouldAnnounceListeningTransition('stopping', 'idle')).toBe(false);
  });
});
