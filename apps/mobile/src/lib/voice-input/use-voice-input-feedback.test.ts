import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runVoiceInputListeningFeedback, showFeedback } from './use-voice-input-actions';

const hapticsMock = vi.hoisted(() => ({ impactAsync: vi.fn().mockResolvedValue(undefined) }));
const accessibilityMock = vi.hoisted(() => ({ announceForAccessibility: vi.fn() }));
const alertMock = vi.hoisted(() => ({ alert: vi.fn() }));
const linkingMock = vi.hoisted(() => ({ openSettings: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  impactAsync: hapticsMock.impactAsync,
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('sonner-native', () => ({ toast: toastMock }));
vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
  Alert: alertMock,
  Linking: linkingMock,
}));

describe('voice input feedback side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('presents settings feedback as an alert with a working settings action', () => {
    showFeedback({
      action: 'open-settings',
      availability: 'available',
      message: 'Microphone access is off. Enable it in Settings.',
      retryable: false,
    });

    const buttons = alertMock.alert.mock.calls[0]?.[2] as
      | { text: string; onPress?: () => void }[]
      | undefined;
    expect(alertMock.alert).toHaveBeenCalledWith(
      'Microphone access is off',
      'Microphone access is off. Enable it in Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: expect.any(Function) },
      ]
    );
    buttons?.find(button => button.text === 'Open Settings')?.onPress?.();
    expect(linkingMock.openSettings).toHaveBeenCalled();
  });

  it('presents feedback without an action as a toast', () => {
    showFeedback({
      action: 'none',
      availability: 'available',
      message: 'No speech detected. Tap the microphone to try again.',
      retryable: true,
    });

    expect(alertMock.alert).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(
      'No speech detected. Tap the microphone to try again.'
    );
  });

  it('announces and haptics only when entering listening', () => {
    runVoiceInputListeningFeedback('idle', 'listening');
    runVoiceInputListeningFeedback('listening', 'listening');
    runVoiceInputListeningFeedback('listening', 'idle');

    expect(hapticsMock.impactAsync).toHaveBeenCalledTimes(1);
    expect(hapticsMock.impactAsync).toHaveBeenCalledWith('light');
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledOnce();
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith('Listening');
  });
});
