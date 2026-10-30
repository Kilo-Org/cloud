/* eslint-disable max-lines -- the controller owns the full start/stop/abort lifecycle and session state machine. */
import { type ExpoSpeechRecognitionResultEvent } from 'expo-speech-recognition';

import {
  classifyVoiceInputError,
  createVoiceTranscriptState,
  type VoiceInputAvailability,
  type VoiceInputFeedback,
  type VoiceInputStatus,
} from './voice-input-state';
import {
  installVoiceInputListeners,
  type VoiceInputSession,
  type VoiceInputSessionController,
} from './voice-input-listeners';
import {
  acquirePermission,
  createTerminal,
  createVoiceInputStartQueue,
  isDisposed,
  isPendingStartCancelled,
  type Lifecycle,
  type PendingVoiceInputStart,
  waitForTerminalOutcome,
} from './voice-input-controller-helpers';

export type VoiceInputNativeEvent = {
  start: null;
  /** Emitted when the recording stopped and the upload/processing phase began. */
  transcribing: null;
  /**
   * Emitted when the session advanced its pending work without reporting a
   * transcript: the gateway engine sends it once per finished segment upload,
   * an empty segment included. The bounded terminal wait measures its silence
   * from here, so a queue that keeps draining is never cut short.
   */
  progress: null;
  result: ExpoSpeechRecognitionResultEvent;
  nomatch: null;
  error: { code?: number; error: string; message: string };
  end: null;
};

export type VoiceInputNativePermission = {
  granted: boolean;
  canAskAgain: boolean;
  restricted?: boolean;
};

export type VoiceInputNativeStartOptions = {
  continuous: boolean;
  interimResults: true;
  lang: string;
  maxAlternatives: 1;
  requiresOnDeviceRecognition: boolean;
};

export type VoiceInputNative = {
  addListener<K extends keyof VoiceInputNativeEvent>(
    event: K,
    listener: (event: VoiceInputNativeEvent[K]) => void
  ): { remove(): void };
  getPermissions(): Promise<VoiceInputNativePermission>;
  requestPermissions(): Promise<VoiceInputNativePermission>;
  isRecognitionAvailable(): boolean;
  supportsContinuousRecognition(): boolean;
  supportsOnDevice(): boolean;
  start(options: VoiceInputNativeStartOptions): void;
  stop(): void;
  abort(): void;
};

export type VoiceInputControllerSnapshot = {
  availability: VoiceInputAvailability;
  owner: string | null;
  status: VoiceInputStatus;
};

export type VoiceInputStartOptions = {
  baseDraft: string;
  languageTag: string;
  onDraftChange: (nextDraft: string) => void;
  onFeedback: (feedback: VoiceInputFeedback) => void;
  owner: string;
  requiresOnDeviceRecognition: boolean;
};

/**
 * Bound on how long `stop`, `abort` and the next `start` wait for a session
 * without progress. A healthy session settles in well under a second, and the
 * gateway engine drains one queued segment per request, so the wait measures
 * silence rather than elapsed time: every finished segment pushes the deadline
 * out, and a bridge that stops answering releases the caller after this much
 * no progress. Two transcription request timeouts
 * (`TRANSCRIPTION_REQUEST_TIMEOUT_MS`) is the longest a healthy request can
 * take without reporting anything.
 */
const VOICE_INPUT_TERMINAL_TIMEOUT_MS = 60_000;

export function createVoiceInputController(native: VoiceInputNative) {
  let availability: VoiceInputAvailability = native.isRecognitionAvailable()
    ? 'available'
    : 'unavailable';
  let owner: string | null = null;
  let status: VoiceInputStatus = 'idle';
  const subscribers = new Set<(snapshot: VoiceInputControllerSnapshot) => void>();
  let session: VoiceInputSession | null = null;
  const startQueue = createVoiceInputStartQueue();
  const lifecycle: Lifecycle = { disposed: false };

  let snapshot: VoiceInputControllerSnapshot = { availability, owner, status };

  const notify = (): void => {
    const next: VoiceInputControllerSnapshot = { availability, owner, status };
    if (
      next.availability === snapshot.availability &&
      next.owner === snapshot.owner &&
      next.status === snapshot.status
    ) {
      return;
    }
    snapshot = next;
    for (const subscriber of subscribers) {
      subscriber(snapshot);
    }
  };

  /**
   * Recompute `availability` from the current native binding and notify on
   * change. The initial value is captured once at construction, so a change
   * of the native binding's answer (e.g. gateway transcription mode toggled
   * on for a device whose OS recognizer is unavailable) is invisible until
   * this runs.
   */
  const refreshAvailability = (): void => {
    const next: VoiceInputAvailability = native.isRecognitionAvailable()
      ? 'available'
      : 'unavailable';
    if (next !== availability) {
      availability = next;
      notify();
    }
  };

  const reportFeedback = (
    feedback: VoiceInputFeedback,
    onFeedback: (feedback: VoiceInputFeedback) => void
  ): void => {
    if (feedback.availability === 'unavailable' && availability !== 'unavailable') {
      availability = 'unavailable';
      notify();
    }
    onFeedback(feedback);
  };

  const reportClientAndTerminalize = (current: VoiceInputSession): void => {
    current.failed = true;
    reportFeedback(classifyVoiceInputError('client'), current.onFeedback);
    terminalize(true);
  };

  const terminalize = (failed: boolean): void => {
    const current = session;
    if (!current || current.terminalized) {
      return;
    }
    current.terminalized = true;
    const ok = !failed;
    current.terminalResolve(ok);
    session = null;
    owner = null;
    status = 'idle';
    notify();
  };

  const sessionController: VoiceInputSessionController = {
    getSession: () => session,
    notify,
    reportFeedback,
    setStatus: next => {
      status = next;
    },
    terminalize,
  };

  const subscriptions: { remove(): void }[] = installVoiceInputListeners(native, sessionController);

  const abortActive = (current: VoiceInputSession): void => {
    current.expectedAbort = true;
    status = 'stopping';
    notify();
    try {
      native.abort();
    } catch {
      reportClientAndTerminalize(current);
    }
  };

  /**
   * Abandon a session whose terminal `end` never arrived within the bound. The
   * mic and any in-flight upload are released, the session settles, and the
   * caller learns the stop did not complete normally. `report` tells the user
   * why: a failed stop keeps their words unsent, while a requested cancel is
   * silent by contract.
   */
  const releaseStalledSession = (current: VoiceInputSession, report: boolean): void => {
    if (report) {
      current.failed = true;
      reportFeedback(classifyVoiceInputError('client'), current.onFeedback);
    }
    try {
      native.abort();
    } catch {
      // Best-effort: releasing the recognizer must not stop the release below.
    }
    terminalize(true);
  };

  const serializeOwnership = async (): Promise<boolean> => {
    const previous = session;
    if (!previous) {
      return true;
    }
    abortActive(previous);
    const outcome = await waitForTerminalOutcome(previous, VOICE_INPUT_TERMINAL_TIMEOUT_MS);
    if (outcome.kind === 'timeout') {
      // The previous session's bridge is not answering; start anyway.
      releaseStalledSession(previous, false);
    }
    return !isDisposed(lifecycle);
  };

  const runStart = async (
    options: VoiceInputStartOptions,
    request: PendingVoiceInputStart
  ): Promise<boolean> => {
    if (isDisposed(lifecycle)) {
      return false;
    }
    if (!native.isRecognitionAvailable()) {
      reportFeedback(classifyVoiceInputError('service-not-allowed'), options.onFeedback);
      return false;
    }
    if (!(await serializeOwnership()) || isPendingStartCancelled(request)) {
      return false;
    }
    const permission = await acquirePermission(native);
    if (isDisposed(lifecycle) || isPendingStartCancelled(request)) {
      return false;
    }
    if (permission.kind === 'client-error') {
      reportFeedback(classifyVoiceInputError('client'), options.onFeedback);
      return false;
    }
    if (permission.kind === 'feedback') {
      reportFeedback(permission.feedback, options.onFeedback);
      return false;
    }
    if (isDisposed(lifecycle) || isPendingStartCancelled(request)) {
      return false;
    }
    const terminal = createTerminal();
    const next: VoiceInputSession = {
      baseDraft: options.baseDraft,
      expectedAbort: false,
      failed: false,
      onDraftChange: options.onDraftChange,
      onFeedback: options.onFeedback,
      owner: options.owner,
      progressAt: Date.now(),
      started: false,
      terminalPromise: terminal.promise,
      terminalResolve: terminal.resolve,
      terminalized: false,
      transcriptState: createVoiceTranscriptState(),
    };
    session = next;
    owner = options.owner;
    status = 'starting';
    notify();

    try {
      native.start({
        continuous: native.supportsContinuousRecognition(),
        interimResults: true,
        lang: options.languageTag,
        maxAlternatives: 1,
        requiresOnDeviceRecognition: options.requiresOnDeviceRecognition,
      });
    } catch {
      reportClientAndTerminalize(next);
      return false;
    }

    return true;
  };

  const start = async ({
    owner: startOwner,
    ...options
  }: VoiceInputStartOptions): Promise<boolean> => {
    const request: PendingVoiceInputStart = { cancelled: false, owner: startOwner };
    const result = await startQueue.run(request, async current => {
      const started = await runStart({ ...options, owner: startOwner }, current);
      return started;
    });
    return result;
  };

  const stop = async (ownerArg: string): Promise<boolean> => {
    startQueue.cancel(ownerArg);
    const current = session;
    if (!current || current.owner !== ownerArg) {
      return true;
    }
    status = 'stopping';
    notify();
    try {
      native.stop();
    } catch {
      current.failed = true;
      current.expectedAbort = true;
      reportFeedback(classifyVoiceInputError('client'), current.onFeedback);
      try {
        native.abort();
      } catch {
        // abort may also throw; terminalize below
      }
      terminalize(true);
      return false;
    }
    const outcome = await waitForTerminalOutcome(current, VOICE_INPUT_TERMINAL_TIMEOUT_MS);
    if (outcome.kind === 'timeout') {
      // The recorder stopped but the recognizer never reported the final
      // transcript: settle anyway so the compose send lock is released.
      releaseStalledSession(current, true);
      return false;
    }
    return outcome.ok;
  };

  const abort = async (ownerArg?: string): Promise<boolean> => {
    startQueue.cancel(ownerArg);
    const current = session;
    if (!current) {
      return true;
    }
    if (ownerArg !== undefined && current.owner !== ownerArg) {
      return true;
    }
    current.expectedAbort = true;
    status = 'stopping';
    notify();
    try {
      native.abort();
    } catch {
      terminalize(true);
      return false;
    }
    const outcome = await waitForTerminalOutcome(current, VOICE_INPUT_TERMINAL_TIMEOUT_MS);
    if (outcome.kind === 'timeout') {
      // A cancel is silent by contract; it only has to free the caller.
      releaseStalledSession(current, false);
      return false;
    }
    return outcome.ok;
  };

  const dispose = (): void => {
    if (isDisposed(lifecycle)) {
      return;
    }
    lifecycle.disposed = true;
    startQueue.cancel();
    const current = session;
    if (current) {
      current.expectedAbort = true;
      try {
        native.abort();
      } catch {
        // abort may throw; force terminalize below
      }
    }
    if (current && !current.terminalized) {
      terminalize(true);
    }
    for (const subscription of subscriptions) {
      subscription.remove();
    }
    subscribers.clear();
  };

  const subscribe = (listener: (snapshot: VoiceInputControllerSnapshot) => void): (() => void) => {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  };

  return {
    abort,
    dispose,
    getSnapshot: () => snapshot,
    refreshAvailability,
    start,
    stop,
    subscribe,
    supportsOnDevice: () => native.supportsOnDevice(),
  };
}
