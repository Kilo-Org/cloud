import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrivacyNativeTestModule } from '../../../modules/local-access-privacy/tests/native-test-helpers';
import { runVoiceInputListeningFeedback, showFeedback } from './use-voice-input-actions';

const adapter = vi.hoisted((): Parameters<typeof createPrivacyNativeTestModule>[0] => ({
  available: true,
  nativeFailure: false,
  secure: false,
  captureFailure: false,
  captureWait: undefined,
  captureEvents: [],
  snapshot: { generation: 0, armed: false, foreground: true, covered: false, failed: false },
  delivered: [],
  queue: [],
  listeners: new Map(),
}));
vi.mock('expo', () => ({
  requireNativeModule: () => createPrivacyNativeTestModule(adapter),
}));
vi.mock('expo-screen-capture', () => ({
  allowScreenCaptureAsync: vi.fn(),
  preventScreenCaptureAsync: vi.fn(),
}));

function deliver() {
  for (const task of adapter.queue.splice(0)) {
    task();
  }
}

const hapticsMock = vi.hoisted(() => ({ impactAsync: vi.fn().mockResolvedValue(undefined) }));
const accessibilityMock = vi.hoisted(() => ({
  // A direct React Native bypass must reach the same observable speech output.
  announceForAccessibility: (message: string) => {
    adapter.delivered.push(message);
  },
}));
const alertMock = vi.hoisted(() => ({ alert: vi.fn() }));
const linkingMock = vi.hoisted(() => ({ openSettings: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  impactAsync: hapticsMock.impactAsync,
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    getSupportedLocales: vi.fn().mockResolvedValue({ locales: [], installedLocales: [] }),
  },
}));
vi.mock('sonner-native', () => ({ toast: toastMock }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
  Alert: alertMock,
  Linking: linkingMock,
}));

describe('voice input feedback side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.available = true;
    adapter.snapshot = {
      generation: 0,
      armed: false,
      foreground: true,
      covered: false,
      failed: false,
    };
    adapter.delivered = [];
    adapter.queue = [];
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

  it.each([false, true])(
    'announces and haptics only when entering listening (armed: %s)',
    armed => {
      adapter.snapshot.armed = armed;
      runVoiceInputListeningFeedback('idle', 'listening');
      runVoiceInputListeningFeedback('listening', 'listening');
      runVoiceInputListeningFeedback('listening', 'idle');

      expect(hapticsMock.impactAsync).toHaveBeenCalledTimes(1);
      expect(hapticsMock.impactAsync).toHaveBeenCalledWith('light');
      expect(adapter.delivered).toEqual([]);
      expect(adapter.queue).toHaveLength(1);
      deliver();
      expect(adapter.delivered).toEqual(['Listening...']);
    }
  );

  it.each([
    { state: 'cancelled unlock', available: true, failed: false },
    { state: 'native failure', available: true, failed: true },
    { state: 'missing native module', available: false, failed: false },
  ])('keeps haptics but drops protected speech after $state without replay', state => {
    adapter.available = state.available;
    adapter.snapshot = {
      generation: 1,
      armed: true,
      foreground: true,
      covered: true,
      failed: state.failed,
    };
    runVoiceInputListeningFeedback('idle', 'listening');
    deliver();
    expect(adapter.delivered).toEqual([]);
    expect(hapticsMock.impactAsync).toHaveBeenCalledTimes(1);
    expect(hapticsMock.impactAsync).toHaveBeenCalledWith('light');

    adapter.available = true;
    adapter.snapshot = { ...adapter.snapshot, generation: 2, covered: false, failed: false };
    runVoiceInputListeningFeedback('listening', 'listening');
    deliver();
    expect(adapter.delivered).toEqual([]);
    expect(hapticsMock.impactAsync).toHaveBeenCalledTimes(1);

    runVoiceInputListeningFeedback('idle', 'listening');
    deliver();
    expect(adapter.delivered).toEqual(['Listening...']);
    expect(hapticsMock.impactAsync).toHaveBeenCalledTimes(2);
  });

  it.each(['covered', 'unlocked'] as const)(
    'drops native-queued listening feedback when delivery runs %s after inactivity',
    deliveryState => {
      adapter.snapshot.armed = true;
      runVoiceInputListeningFeedback('idle', 'listening');
      expect(adapter.queue).toHaveLength(1);
      expect(adapter.delivered).toEqual([]);

      // The native queue outlives the JavaScript transition that requested speech.
      adapter.snapshot = { ...adapter.snapshot, generation: 1, foreground: false, covered: true };
      if (deliveryState === 'unlocked') {
        adapter.snapshot = { ...adapter.snapshot, generation: 2, foreground: true, covered: false };
      }
      deliver();
      expect(adapter.delivered).toEqual([]);

      adapter.snapshot = { ...adapter.snapshot, generation: 2, foreground: true, covered: false };
      runVoiceInputListeningFeedback('listening', 'listening');
      deliver();
      expect(adapter.delivered).toEqual([]);
      expect(hapticsMock.impactAsync).toHaveBeenCalledTimes(1);

      runVoiceInputListeningFeedback('idle', 'listening');
      deliver();
      expect(adapter.delivered).toEqual(['Listening...']);
    }
  );

  it('stays silent without a listening transition', () => {
    runVoiceInputListeningFeedback(null, 'idle');
    runVoiceInputListeningFeedback('idle', 'starting');
    runVoiceInputListeningFeedback('starting', 'idle');
    deliver();

    expect(adapter.delivered).toEqual([]);
    expect(hapticsMock.impactAsync).not.toHaveBeenCalled();
  });
});
