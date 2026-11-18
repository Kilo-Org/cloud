import { describe, expect, it } from 'vitest';

import { classifyVoiceInputError } from './voice-input-state';

describe('classifyVoiceInputError - gateway codes', () => {
  it('maps gateway-unreachable to retryable feedback with its own copy', () => {
    expect(classifyVoiceInputError('gateway-unreachable')).toEqual({
      action: 'none',
      availability: 'available',
      message: "Couldn't reach the Kilo gateway. Check your connection and try again.",
      retryable: true,
    });
  });

  it('maps gateway-timeout to retryable feedback with its own copy', () => {
    expect(classifyVoiceInputError('gateway-timeout')).toEqual({
      action: 'none',
      availability: 'available',
      message: 'Transcription took too long. Try again.',
      retryable: true,
    });
  });

  it('maps gateway-model-unavailable to non-retryable feedback that opens the transcription settings', () => {
    expect(classifyVoiceInputError('gateway-model-unavailable')).toEqual({
      action: 'open-transcription-settings',
      availability: 'available',
      message: "This transcription model isn't available. Pick another one in Preferences.",
      retryable: false,
    });
  });

  it('maps gateway-auth to non-retryable sign-in feedback', () => {
    expect(classifyVoiceInputError('gateway-auth')).toEqual({
      action: 'none',
      availability: 'available',
      message: 'Sign in to use gateway transcription.',
      retryable: false,
    });
  });

  it('maps gateway-no-model to non-retryable feedback that opens the transcription settings', () => {
    expect(classifyVoiceInputError('gateway-no-model')).toEqual({
      action: 'open-transcription-settings',
      availability: 'available',
      message: 'Choose a transcription model in Preferences first.',
      retryable: false,
    });
  });

  it('maps gateway-server to the generic retryable stopped feedback', () => {
    expect(classifyVoiceInputError('gateway-server')).toEqual({
      action: 'none',
      availability: 'available',
      message: 'Voice input stopped. Tap the microphone to try again.',
      retryable: true,
    });
  });

  it('maps gateway-invalid-response to the generic retryable stopped feedback', () => {
    expect(classifyVoiceInputError('gateway-invalid-response')).toEqual({
      action: 'none',
      availability: 'available',
      message: 'Voice input stopped. Tap the microphone to try again.',
      retryable: true,
    });
  });
});
