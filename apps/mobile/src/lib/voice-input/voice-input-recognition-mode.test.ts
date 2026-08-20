import { describe, expect, it } from 'vitest';

import { resolveVoiceInputRecognitionMode } from './voice-input-recognition-mode';

describe('resolveVoiceInputRecognitionMode', () => {
  it('returns on-device when on-device is supported, regardless of consent', () => {
    expect(resolveVoiceInputRecognitionMode(true, 'unset')).toBe('on-device');
    expect(resolveVoiceInputRecognitionMode(true, 'granted')).toBe('on-device');
    expect(resolveVoiceInputRecognitionMode(true, 'declined')).toBe('on-device');
  });

  it('returns network when on-device is unsupported and consent is granted', () => {
    expect(resolveVoiceInputRecognitionMode(false, 'granted')).toBe('network');
  });

  it('returns blocked when on-device is unsupported and consent is unset', () => {
    expect(resolveVoiceInputRecognitionMode(false, 'unset')).toBe('blocked');
  });

  it('returns blocked when on-device is unsupported and consent is declined', () => {
    expect(resolveVoiceInputRecognitionMode(false, 'declined')).toBe('blocked');
  });
});
