import { describe, expect, it } from 'vitest';

import {
  resolveVoiceInputRecognitionMode,
  resolveVoiceTranscriptionReviewMode,
} from './voice-input-recognition-mode';

describe('resolveVoiceTranscriptionReviewMode', () => {
  it('claims the gateway while the gateway switch is on, even on an on-device-capable device', () => {
    expect(
      resolveVoiceTranscriptionReviewMode({
        gatewayTranscriptionEnabled: true,
        serviceSupportsOnDevice: true,
        languageInstalledOnDevice: true,
      })
    ).toBe('gateway');
  });

  it('claims on-device only when the service supports it AND the resolved language has its offline model', () => {
    expect(
      resolveVoiceTranscriptionReviewMode({
        gatewayTranscriptionEnabled: false,
        serviceSupportsOnDevice: true,
        languageInstalledOnDevice: true,
      })
    ).toBe('on-device');
  });

  it('falls back to online when the service supports on-device but the language model is missing', () => {
    // Regression: the privacy row printed "On device" from the service-level
    // check alone, while the mic raised the online disclosure for the same
    // state (the language's offline model is not installed).
    expect(
      resolveVoiceTranscriptionReviewMode({
        gatewayTranscriptionEnabled: false,
        serviceSupportsOnDevice: true,
        languageInstalledOnDevice: false,
      })
    ).toBe('online');
  });

  it('is online when the service cannot recognize on-device at all', () => {
    expect(
      resolveVoiceTranscriptionReviewMode({
        gatewayTranscriptionEnabled: false,
        serviceSupportsOnDevice: false,
        languageInstalledOnDevice: false,
      })
    ).toBe('online');
  });

  it('keeps the gateway claim when the language gate has not resolved', () => {
    // The pending gate (`null` → treated as not installed) must not flip a
    // gateway-on row to online while the model probe is in flight.
    expect(
      resolveVoiceTranscriptionReviewMode({
        gatewayTranscriptionEnabled: true,
        serviceSupportsOnDevice: false,
        languageInstalledOnDevice: false,
      })
    ).toBe('gateway');
  });
});

describe('resolveVoiceInputRecognitionMode', () => {
  it('prefers on-device regardless of consent', () => {
    expect(resolveVoiceInputRecognitionMode(true, 'unset')).toBe('on-device');
    expect(resolveVoiceInputRecognitionMode(true, 'declined')).toBe('on-device');
  });

  it('allows network recognition only on granted consent', () => {
    expect(resolveVoiceInputRecognitionMode(false, 'granted')).toBe('network');
    expect(resolveVoiceInputRecognitionMode(false, 'unset')).toBe('blocked');
    expect(resolveVoiceInputRecognitionMode(false, 'declined')).toBe('blocked');
  });
});
