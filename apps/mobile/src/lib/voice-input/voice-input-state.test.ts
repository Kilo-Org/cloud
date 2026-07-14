import { describe, expect, it } from 'vitest';
import { type ExpoSpeechRecognitionErrorCode } from 'expo-speech-recognition';

import {
  appendVoiceTranscript,
  applyVoiceRecognitionResult,
  classifyVoiceInputError,
  classifyVoiceInputPermission,
  createVoiceTranscriptState,
  shouldAbortVoiceInput,
} from './voice-input-state';

describe('createVoiceTranscriptState', () => {
  it('starts with empty finals, empty interim, and empty transcript', () => {
    const state = createVoiceTranscriptState();
    expect(state).toEqual({ finalSegments: [], interim: '', transcript: '' });
  });

  it('returns a fresh state each call so consumers cannot share references', () => {
    const left = createVoiceTranscriptState();
    const right = createVoiceTranscriptState();
    expect(left).not.toBe(right);
    expect(left.finalSegments).not.toBe(right.finalSegments);
  });
});

describe('applyVoiceRecognitionResult', () => {
  it('replaces the prior interim on each partial result rather than appending', () => {
    const first = applyVoiceRecognitionResult(createVoiceTranscriptState(), {
      isFinal: false,
      transcript: 'hel',
    });
    const second = applyVoiceRecognitionResult(first, { isFinal: false, transcript: 'hello' });
    const third = applyVoiceRecognitionResult(second, {
      isFinal: false,
      transcript: 'hello world',
    });

    expect(third.finalSegments).toEqual([]);
    expect(third.interim).toBe('hello world');
    expect(third.transcript).toBe('hello world');
  });

  it('treats the latest interim as the only interim text after several partials', () => {
    let state = createVoiceTranscriptState();
    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      state = applyVoiceRecognitionResult(state, { isFinal: false, transcript: text });
    }

    expect(state.interim).toBe('hello');
    expect(state.transcript).toBe('hello');
  });

  it('accumulates final segments Android-style and clears the interim', () => {
    let state = createVoiceTranscriptState();
    state = applyVoiceRecognitionResult(state, { isFinal: false, transcript: 'hello' });
    state = applyVoiceRecognitionResult(state, { isFinal: true, transcript: 'hello' });
    state = applyVoiceRecognitionResult(state, { isFinal: true, transcript: 'there' });

    expect(state.finalSegments).toEqual(['hello', 'there']);
    expect(state.interim).toBe('');
    expect(state.transcript).toBe('hello there');
  });

  it('places a new interim after the accumulated finals in the rendered transcript', () => {
    let state = createVoiceTranscriptState();
    state = applyVoiceRecognitionResult(state, { isFinal: true, transcript: 'hello' });
    state = applyVoiceRecognitionResult(state, { isFinal: true, transcript: 'there' });
    state = applyVoiceRecognitionResult(state, { isFinal: false, transcript: 'friend' });

    expect(state.finalSegments).toEqual(['hello', 'there']);
    expect(state.interim).toBe('friend');
    expect(state.transcript).toBe('hello there friend');
  });

  it('renders a final that follows an interim without leaking the interim text', () => {
    let state = createVoiceTranscriptState();
    state = applyVoiceRecognitionResult(state, { isFinal: false, transcript: 'drafting' });
    state = applyVoiceRecognitionResult(state, { isFinal: true, transcript: 'drafting' });

    expect(state.finalSegments).toEqual(['drafting']);
    expect(state.interim).toBe('');
    expect(state.transcript).toBe('drafting');
  });

  it('trims surrounding whitespace from an interim result', () => {
    const state = applyVoiceRecognitionResult(createVoiceTranscriptState(), {
      isFinal: false,
      transcript: '  hello  ',
    });

    expect(state.finalSegments).toEqual([]);
    expect(state.interim).toBe('hello');
    expect(state.transcript).toBe('hello');
  });

  it('stores a final segment with surrounding whitespace trimmed', () => {
    const state = applyVoiceRecognitionResult(createVoiceTranscriptState(), {
      isFinal: true,
      transcript: '  hello  ',
    });

    expect(state.finalSegments).toEqual(['hello']);
    expect(state.interim).toBe('');
    expect(state.transcript).toBe('hello');
  });

  it('clears the interim on a whitespace-only final and does not append an empty segment or spacing', () => {
    let state = createVoiceTranscriptState();
    state = applyVoiceRecognitionResult(state, { isFinal: false, transcript: 'drafting' });
    state = applyVoiceRecognitionResult(state, { isFinal: true, transcript: '   ' });

    expect(state.finalSegments).toEqual([]);
    expect(state.interim).toBe('');
    expect(state.transcript).toBe('');
  });
});

describe('appendVoiceTranscript', () => {
  it('returns just the trimmed transcript when the base draft is empty', () => {
    expect(appendVoiceTranscript('', 'hello')).toBe('hello');
  });

  it('inserts exactly one space when the base does not end in whitespace', () => {
    expect(appendVoiceTranscript('hello', 'world')).toBe('hello world');
  });

  it('does not add an extra separator when the base already ends in whitespace', () => {
    expect(appendVoiceTranscript('hello ', 'world')).toBe('hello world');
    expect(appendVoiceTranscript('hello\n', 'world')).toBe('hello\nworld');
  });

  it('trims only the leading whitespace of the appended transcript', () => {
    expect(appendVoiceTranscript('hello', '   world')).toBe('hello world');
    expect(appendVoiceTranscript('hello', '  world  again')).toBe('hello world  again');
  });

  it('preserves the base draft when the appended transcript is empty', () => {
    expect(appendVoiceTranscript('hello', '')).toBe('hello');
    expect(appendVoiceTranscript('hello', '   ')).toBe('hello');
  });
});

describe('classifyVoiceInputPermission', () => {
  it('returns null when the permission has been granted', () => {
    expect(classifyVoiceInputPermission({ granted: true, canAskAgain: true })).toBeNull();
    expect(
      classifyVoiceInputPermission({ granted: true, canAskAgain: true, restricted: true })
    ).toBeNull();
  });

  it('returns retryable feedback for a requestable denial', () => {
    const feedback = classifyVoiceInputPermission({ granted: false, canAskAgain: true });
    expect(feedback).toEqual({
      action: 'none',
      availability: 'available',
      message: 'Microphone access is required for voice input.',
      retryable: true,
    });
  });

  it('returns open-settings feedback for a permanent denial', () => {
    const feedback = classifyVoiceInputPermission({ granted: false, canAskAgain: false });
    expect(feedback).toEqual({
      action: 'open-settings',
      availability: 'available',
      message: 'Microphone access is off. Enable it in Settings to use voice input.',
      retryable: false,
    });
  });

  it('returns a restricted feedback when the device reports a content restriction', () => {
    const feedback = classifyVoiceInputPermission({
      granted: false,
      canAskAgain: false,
      restricted: true,
    });
    expect(feedback).toEqual({
      action: 'none',
      availability: 'available',
      message: 'Voice input is restricted on this device.',
      retryable: false,
    });
  });
});

describe('classifyVoiceInputError', () => {
  const retryableErrorCases: {
    code: ExpoSpeechRecognitionErrorCode;
    message: string;
  }[] = [
    { code: 'no-speech', message: 'No speech detected. Tap the microphone to try again.' },
    { code: 'speech-timeout', message: 'No speech detected. Tap the microphone to try again.' },
    { code: 'network', message: 'Voice input needs a connection right now. Try again.' },
    { code: 'busy', message: 'Voice input is busy. Try again.' },
    {
      code: 'audio-capture',
      message: 'Voice input stopped. Tap the microphone to try again.',
    },
    {
      code: 'interrupted',
      message: 'Voice input stopped. Tap the microphone to try again.',
    },
    { code: 'client', message: 'Voice input stopped. Tap the microphone to try again.' },
    { code: 'unknown', message: 'Voice input stopped. Tap the microphone to try again.' },
    { code: 'bad-grammar', message: 'Voice input stopped. Tap the microphone to try again.' },
    { code: 'aborted', message: 'Voice input stopped. Tap the microphone to try again.' },
  ];

  it.each(retryableErrorCases)(
    'maps $code to a retryable available feedback with a specific message',
    ({ code, message }) => {
      const feedback = classifyVoiceInputError(code);
      expect(feedback).toEqual({
        action: 'none',
        availability: 'available',
        message,
        retryable: true,
      });
    }
  );

  it('maps not-allowed to the permanent open-settings feedback', () => {
    expect(classifyVoiceInputError('not-allowed')).toEqual({
      action: 'open-settings',
      availability: 'available',
      message: 'Microphone access is off. Enable it in Settings to use voice input.',
      retryable: false,
    });
  });

  it('maps service-not-allowed to a non-retryable unavailable feedback', () => {
    expect(classifyVoiceInputError('service-not-allowed')).toEqual({
      action: 'none',
      availability: 'unavailable',
      message: "Voice input isn't available on this device.",
      retryable: false,
    });
  });

  it('maps language-not-supported to a non-retryable unavailable feedback', () => {
    expect(classifyVoiceInputError('language-not-supported')).toEqual({
      action: 'none',
      availability: 'unavailable',
      message: "Voice input isn't available for this device language.",
      retryable: false,
    });
  });

  it('maps an unknown error string to a generic retryable available feedback', () => {
    expect(classifyVoiceInputError('future-native-error')).toEqual({
      action: 'none',
      availability: 'available',
      message: 'Voice input stopped. Tap the microphone to try again.',
      retryable: true,
    });
  });
});

describe('shouldAbortVoiceInput', () => {
  it('returns true when the controller is disabled', () => {
    expect(shouldAbortVoiceInput({ appState: 'active', disabled: true })).toBe(true);
  });

  it('returns true when the app is not in the active state', () => {
    expect(shouldAbortVoiceInput({ appState: 'background', disabled: false })).toBe(true);
    expect(shouldAbortVoiceInput({ appState: 'inactive', disabled: false })).toBe(true);
  });

  it('returns true when both disabled and not active', () => {
    expect(shouldAbortVoiceInput({ appState: 'background', disabled: true })).toBe(true);
  });

  it('returns false when the app is active and the controller is not disabled', () => {
    expect(shouldAbortVoiceInput({ appState: 'active', disabled: false })).toBe(false);
  });
});
