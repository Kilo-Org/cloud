import {
  appendVoiceTranscript,
  applyVoiceRecognitionResult,
  classifyVoiceInputError,
  type VoiceInputFeedback,
  type VoiceInputStatus,
  type VoiceTranscriptState,
} from './voice-input-state';
import { type VoiceInputNative, type VoiceInputNativeEvent } from './voice-input-controller';
export type VoiceInputSession = {
  baseDraft: string;
  expectedAbort: boolean;
  failed: boolean;
  onDraftChange: (nextDraft: string) => void;
  onFeedback: (feedback: VoiceInputFeedback) => void;
  owner: string;
  /**
   * When this session last advanced: it started, produced a final transcript,
   * or finished one queued unit of work. The bounded terminal wait measures
   * its silence from here, so a slow drain that keeps delivering is not cut
   * short.
   */
  progressAt: number;
  /**
   * True once this session received its own `start`. A recognizer cannot
   * report a transcript before it started, so anything that arrives earlier
   * belongs to a session the controller already abandoned.
   */
  started: boolean;
  terminalPromise: Promise<boolean>;
  terminalResolve: (ok: boolean) => void;
  terminalized: boolean;
  transcriptState: VoiceTranscriptState;
};

export type VoiceInputSessionController = {
  getSession(): VoiceInputSession | null;
  notify(): void;
  reportFeedback(
    feedback: VoiceInputFeedback,
    onFeedback: (feedback: VoiceInputFeedback) => void
  ): void;
  setStatus(status: VoiceInputStatus): void;
  terminalize(failed: boolean): void;
};

type Subscription = { remove(): void };

export function installVoiceInputListeners(
  native: VoiceInputNative,
  controller: VoiceInputSessionController
): Subscription[] {
  const onStart: (event: VoiceInputNativeEvent['start']) => void = () => {
    const current = controller.getSession();
    if (!current || current.terminalized || current.expectedAbort) {
      return;
    }
    current.started = true;
    controller.setStatus('listening');
    controller.notify();
  };

  const onTranscribing: (event: VoiceInputNativeEvent['transcribing']) => void = () => {
    const current = controller.getSession();
    if (!current || current.terminalized || current.expectedAbort || !current.started) {
      return;
    }
    controller.setStatus('transcribing');
    controller.notify();
  };

  const onProgress: (event: VoiceInputNativeEvent['progress']) => void = () => {
    const current = controller.getSession();
    if (!current || current.terminalized) {
      return;
    }
    current.progressAt = Date.now();
  };

  const onResult: (event: VoiceInputNativeEvent['result']) => void = event => {
    const current = controller.getSession();
    if (!current || current.terminalized || current.expectedAbort || !current.started) {
      return;
    }
    const first = event.results[0];
    if (!first) {
      return;
    }
    const transcript = first.transcript;
    if (transcript.length === 0) {
      return;
    }
    current.transcriptState = applyVoiceRecognitionResult(current.transcriptState, {
      isFinal: event.isFinal,
      transcript,
    });
    const nextDraft = appendVoiceTranscript(current.baseDraft, current.transcriptState.transcript);
    current.onDraftChange(nextDraft);
    if (event.isFinal) {
      // A final transcript is a recognized word run: the session advanced, so
      // an in-flight stop keeps waiting instead of abandoning it.
      current.progressAt = Date.now();
    }
  };

  const onNomatch: (event: VoiceInputNativeEvent['nomatch']) => void = () => {
    const current = controller.getSession();
    if (
      !current ||
      current.terminalized ||
      current.expectedAbort ||
      current.failed ||
      !current.started
    ) {
      return;
    }
    current.failed = true;
    controller.reportFeedback(classifyVoiceInputError('no-speech'), current.onFeedback);
  };

  const onError: (event: VoiceInputNativeEvent['error']) => void = event => {
    const current = controller.getSession();
    if (!current || current.terminalized) {
      return;
    }
    if (current.expectedAbort && event.error === 'aborted') {
      return;
    }
    if (current.failed) {
      return;
    }
    current.failed = true;
    controller.reportFeedback(classifyVoiceInputError(event.error), current.onFeedback);
  };

  const onEnd: (event: VoiceInputNativeEvent['end']) => void = () => {
    const current = controller.getSession();
    if (!current || current.terminalized) {
      return;
    }
    controller.terminalize(current.failed);
  };

  return [
    native.addListener('start', onStart),
    native.addListener('transcribing', onTranscribing),
    native.addListener('progress', onProgress),
    native.addListener('result', onResult),
    native.addListener('nomatch', onNomatch),
    native.addListener('error', onError),
    native.addListener('end', onEnd),
  ];
}
