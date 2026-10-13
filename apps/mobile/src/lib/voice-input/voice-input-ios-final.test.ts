import { type ExpoSpeechRecognitionResultEvent } from 'expo-speech-recognition';
import { describe, expect, it } from 'vitest';

import { dropIosRepeatedFinal } from './voice-input-ios-final';

function result(isFinal: boolean, transcript: string): ExpoSpeechRecognitionResultEvent {
  return { isFinal, results: [{ transcript, confidence: 1, segments: [] }] };
}

function deliver(events: ExpoSpeechRecognitionResultEvent[]): string[] {
  const received: string[] = [];
  const listener = dropIosRepeatedFinal(event => {
    received.push(`${event.isFinal ? 'final' : 'interim'}:${event.results[0]?.transcript ?? ''}`);
  });
  for (const event of events) {
    listener(event);
  }
  return received;
}

describe('dropIosRepeatedFinal', () => {
  it('drops the stop final that repeats the final-like result before it', () => {
    // iOS 18+ order on stop: interim, final-like (speechDuration > 0), then the
    // task's real final, which the module prefixes with a space.
    expect(
      deliver([
        result(false, 'hello world'),
        result(true, 'hello world'),
        result(true, ' hello world'),
      ])
    ).toEqual(['interim:hello world', 'final:hello world']);
  });

  it('keeps a spoken repeat when interim results arrive between the two finals', () => {
    expect(deliver([result(true, 'yes'), result(false, ' yes'), result(true, ' yes')])).toEqual([
      'final:yes',
      'interim: yes',
      'final: yes',
    ]);
  });
});
