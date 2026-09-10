import {
  appendVoiceTranscript,
  applyVoiceRecognitionResult,
  classifyVoiceInputEngineFallback,
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
    controller.setStatus('listening');
    controller.notify();
  };

  const onTranscribing: (event: VoiceInputNativeEvent['transcribing']) => void = () => {
    const current = controller.getSession();
    if (!current || current.terminalized || current.expectedAbort) {
      return;
    }
    controller.setStatus('transcribing');
    controller.notify();
  };

  const onResult: (event: VoiceInputNativeEvent['result']) => void = event => {
    const current = controller.getSession();
    if (!current || current.terminalized || current.expectedAbort) {
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
  };

  const onNomatch: (event: VoiceInputNativeEvent['nomatch']) => void = () => {
    const current = controller.getSession();
    if (!current || current.terminalized || current.expectedAbort || current.failed) {
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

  const onEngineFellBack: (event: VoiceInputNativeEvent['engine-fell-back']) => void = event => {
    const current = controller.getSession();
    // The hand-off toast belongs to a live session only: a terminalized or
    // already-failed session has had its message, and an expected abort was
    // the user's own decision.
    if (!current || current.terminalized || current.expectedAbort || current.failed) {
      return;
    }
    controller.reportFeedback(classifyVoiceInputEngineFallback(event), current.onFeedback);
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
    native.addListener('result', onResult),
    native.addListener('nomatch', onNomatch),
    native.addListener('error', onError),
    native.addListener('engine-fell-back', onEngineFellBack),
    native.addListener('end', onEnd),
  ];
}
