import { type ExpoSpeechRecognitionResultEvent } from 'expo-speech-recognition';

type ResultListener = (event: ExpoSpeechRecognitionResultEvent) => void;

/**
 * Wraps an iOS result listener to drop the duplicate final result the
 * recognizer can deliver on stop.
 *
 * On iOS 18 and later, expo-speech-recognition reports the end of an
 * utterance as a final result (`speechDuration > 0`). After `stop()`, the
 * recognition task can then deliver its real final result with the same
 * text. Both arrive as `isFinal: true`, so the transcript reducer appends the
 * text twice. A real new utterance always sends interim results first, so a
 * final that repeats the previous final with no interim between is the
 * duplicate. The real final is sometimes empty, so the bug is intermittent.
 *
 * The engine selector subscribes once per session, so each session gets a
 * fresh wrapper.
 */
export function dropIosRepeatedFinal(listener: ResultListener): ResultListener {
  let lastFinal: string | null = null;

  return event => {
    const transcript = event.results[0]?.transcript.trim() ?? '';
    if (transcript.length > 0) {
      if (event.isFinal && transcript === lastFinal) {
        return;
      }
      lastFinal = event.isFinal ? transcript : null;
    }
    listener(event);
  };
}
