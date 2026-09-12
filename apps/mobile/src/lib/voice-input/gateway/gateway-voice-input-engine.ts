/* eslint-disable max-lines -- one session state machine: start, rotation, upload, stop, abort, and recording cleanup share the session lifecycle. */
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';

import {
  type VoiceInputNative,
  type VoiceInputNativeEvent,
  type VoiceInputNativePermission,
  type VoiceInputNativeStartOptions,
} from '../voice-input-controller';
import {
  classifyTranscriptionFailure,
  transcribeRecording,
  type TranscribeRecordingInput,
  type TranscribeRecordingResult,
} from './gateway-transcription-client';

/**
 * How long one recording segment lasts before the engine stops the current
 * recorder and starts a fresh one. The gateway has no streaming endpoint, so
 * "real time" is a sequence of short batch uploads whose final results the
 * controller appends to the live draft while `status` stays `listening`.
 */
const GATEWAY_SEGMENT_DURATION_MS = 3000;

/**
 * The slice of an expo-audio recorder the engine drives. `AudioModule.AudioRecorder`
 * satisfies it structurally; tests fake it. `release()` detaches the native
 * object — every path that stops owning a recorder must call it exactly once.
 */
export type GatewayRecorder = {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  release(): void;
};

export type GatewayVoiceInputEngineDeps = {
  setAudioMode(mode: { allowsRecording: true }): Promise<void>;
  createRecorder(): GatewayRecorder;
  /**
   * The transcription model to use: the stored choice, else the first model
   * the gateway catalogue offers, else null when none can be resolved.
   */
  readModelId(): Promise<{ id: string; name: string } | null>;
  readAuthToken(): Promise<string | null>;
  readOrganizationId(): Promise<string | null>;
  /**
   * Best-effort delete of a recording file once the engine is done with it.
   * `release()` frees the native object, not the file on disk. A failure must
   * never change the session outcome. Declared as a property (not a method) so
   * the engine can hold a detached reference; void-returning is allowed because
   * the modern File API deletes synchronously.
   */
  deleteRecording: (uri: string) => void | Promise<void>;
  /**
   * Defaults to the real gateway client; tests inject a fake. Declared as a
   * property (not a method) so the engine can hold a detached reference.
   */
  upload?: ((input: TranscribeRecordingInput) => Promise<TranscribeRecordingResult>) | undefined;
  /**
   * Length of one recording segment before the engine rotates to a fresh
   * recorder. Defaults to `GATEWAY_SEGMENT_DURATION_MS`; tests shorten it to
   * drive rotations without waiting.
   */
  segmentDurationMs?: number;
};

type RecorderHandle = {
  released: boolean;
  recorder: GatewayRecorder;
};

/** Session-scoped reads, resolved once before the first segment upload. */
type GatewayCredentials = {
  model: { id: string; name: string };
  authToken: string;
  organizationId: string | null;
};

type GatewaySession = {
  /** Monotonic id; every async continuation checks it still owns the session. */
  id: number;
  /** BCP-47 hint carried from `start()` into every segment upload. */
  languageTag: string;
  /** The recorder we currently own, or null once it has been detached. */
  handle: RecorderHandle | null;
  /** Set when `stop()` arrives while the recorder is still preparing. */
  stopRequested: boolean;
  /** Owns the in-flight upload; `abort()` cancels it. */
  uploadController: AbortController | null;
  /** Set by `stop()`/`abort()`; a stopped session never rotates again. */
  stopped: boolean;
  /** True once the first recorder has started, i.e. `start` was emitted. */
  recordingStarted: boolean;
  /** Pending rotation timer, or null when none is scheduled. */
  rotationTimer: ReturnType<typeof setTimeout> | null;
  /** True while a rotation stops the old segment and starts the next. */
  rotationInFlight: boolean;
  /** Guards `finalizeStop` so stop/rotation races emit `end` exactly once. */
  finalizing: boolean;
  /** True once any segment produced non-empty text. */
  producedText: boolean;
  /** Serializes segment uploads so their results apply in recording order. */
  uploadChain: Promise<void>;
  /** Session-scoped credentials, cached before the first upload. */
  credentials: GatewayCredentials | null;
};

/** Outcome of detaching a completed segment: its file URI, or a failed stop. */
type CapturedSegment = { ok: true; uri: string | null } | { ok: false };

type AnyListener = (event: VoiceInputNativeEvent[keyof VoiceInputNativeEvent]) => void;

/**
 * Release a recorder exactly once. `SharedObject.release()` throws on a
 * second call, and the abort/finish paths can race for the same handle.
 */
function releaseRecorder(handle: RecorderHandle): void {
  if (handle.released) {
    return;
  }
  handle.released = true;
  try {
    handle.recorder.release();
  } catch {
    // The native object may already be gone; nothing left to free.
  }
}

/**
 * Delete a recording file, best-effort. A missing or undeletable file must
 * never change the session outcome, so every failure is swallowed. A null or
 * empty URI means the recorder never produced a file.
 */
async function deleteRecordingFile(
  deleteRecording: (uri: string) => void | Promise<void>,
  uri: string | null
): Promise<void> {
  if (uri === null || uri === '') {
    return;
  }
  try {
    await deleteRecording(uri);
  } catch {
    // Cleanup is best-effort; the session outcome is already decided.
  }
}

/**
 * Free a recorder and delete its file once the engine stops owning it. The URI
 * is read before `release()`: a released shared object refuses the read.
 */
async function releaseAndDeleteRecording(
  handle: RecorderHandle,
  deleteRecording: (uri: string) => void | Promise<void>
): Promise<void> {
  let uri: string | null = null;
  try {
    uri = handle.recorder.uri;
  } catch {
    // A recorder that refuses a URI read has no file to delete.
  }
  releaseRecorder(handle);
  await deleteRecordingFile(deleteRecording, uri);
}

/**
 * Discard an aborted recording: end capture, free the native object, then
 * delete the file. A recorder that refuses to stop (sync throw or rejection)
 * still gets released and its file deleted, exactly once.
 */
async function discardRecording(
  handle: RecorderHandle,
  deleteRecording: (uri: string) => void | Promise<void>
): Promise<void> {
  try {
    await handle.recorder.stop();
  } catch {
    // The session is already gone; the cleanup below is what matters.
  }
  await releaseAndDeleteRecording(handle, deleteRecording);
}

/** Cancel a session's pending segment rotation, if one is armed. */
function clearRotationTimer(current: GatewaySession): void {
  if (current.rotationTimer !== null) {
    clearTimeout(current.rotationTimer);
    current.rotationTimer = null;
  }
}

/**
 * Read the live `stopped` flag. A concurrent `stop()` flips it across an
 * await, which control-flow narrowing would otherwise hide.
 */
function isStopped(current: GatewaySession): boolean {
  return current.stopped;
}

/**
 * Gateway transcription engine: record with expo-audio in short segments,
 * upload each finished segment to the Kilo gateway, and emit one final result
 * per segment while the session is still listening. It implements the same
 * `VoiceInputNative` protocol as the OS binding so the controller cannot tell
 * them apart.
 *
 * Event protocol per session: `start` → zero or more `result` (one per
 * transcribed segment, still `listening`) → (`stop()`) `transcribing` →
 * `result`|`error` → `end`. `abort()` ends the session without a result.
 * Every failure path terminalizes with `error` + `end` so the controller's
 * session never hangs; the recorder's native object is released on every path
 * that stops owning it, and each segment file is deleted after its upload.
 */
export function createGatewayVoiceInputEngine(deps: GatewayVoiceInputEngineDeps): VoiceInputNative {
  const upload = deps.upload ?? transcribeRecording;
  const { deleteRecording } = deps;
  const segmentDurationMs = deps.segmentDurationMs ?? GATEWAY_SEGMENT_DURATION_MS;
  const listeners = new Map<keyof VoiceInputNativeEvent, Set<AnyListener>>();
  let session: GatewaySession | null = null;
  let sessionSeq = 0;

  const emit = <K extends keyof VoiceInputNativeEvent>(
    event: K,
    payload: VoiceInputNativeEvent[K]
  ): void => {
    const set = listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of set) {
      (listener as (event: VoiceInputNativeEvent[K]) => void)(payload);
    }
  };

  /** True once another session (or `abort()`) has taken ownership. */
  const stale = (current: GatewaySession): boolean => session !== current;

  const endSession = (current: GatewaySession): void => {
    if (session === current) {
      session = null;
    }
    emit('end', null);
  };

  /**
   * Terminalize the session on a failure. The rotation timer is cleared and
   * any recorder the session still owns is discarded: a failure can land
   * between rotations, when a fresh segment is already recording.
   */
  const fail = (current: GatewaySession, code: string): void => {
    emit('error', { error: code, message: `gateway-voice-input: ${code}` });
    clearRotationTimer(current);
    const handle = current.handle;
    current.handle = null;
    if (handle) {
      void discardRecording(handle, deleteRecording);
    }
    endSession(current);
  };

  /**
   * Stop a completed segment's recorder and hand back its file URI, freeing
   * the native object but not the file: the upload still needs it.
   */
  const detachSegment = async (handle: RecorderHandle): Promise<CapturedSegment> => {
    try {
      await handle.recorder.stop();
    } catch {
      await releaseAndDeleteRecording(handle, deleteRecording);
      return { ok: false };
    }
    let uri: string | null = null;
    try {
      uri = handle.recorder.uri;
    } catch {
      // A recorder that refuses a URI read has no file to delete.
    }
    releaseRecorder(handle);
    return { ok: true, uri };
  };

  /**
   * Transcribe one finished segment and emit its final result. Empty or
   * no-speech segments are skipped silently; a real failure terminalizes the
   * session with the classified gateway code. The file is deleted on every
   * path, including an aborted upload.
   */
  const uploadSegment = async (current: GatewaySession, uri: string): Promise<void> => {
    try {
      if (stale(current)) {
        return;
      }
      let credentials = current.credentials;
      if (credentials === null) {
        const model = await deps.readModelId();
        if (stale(current)) {
          return;
        }
        if (model === null) {
          fail(current, 'gateway-no-model');
          return;
        }
        let authToken: string | null = null;
        let organizationId: string | null = null;
        try {
          authToken = await deps.readAuthToken();
          organizationId = await deps.readOrganizationId();
        } catch {
          if (!stale(current)) {
            fail(current, 'client');
          }
          return;
        }
        if (stale(current)) {
          return;
        }
        if (authToken === null || authToken === '') {
          // Without a token the gateway will answer 401; tell the user to sign
          // in instead of burning an upload round-trip.
          fail(current, 'gateway-auth');
          return;
        }
        credentials = { authToken, model, organizationId };
        current.credentials = credentials;
      }
      const controller = new AbortController();
      current.uploadController = controller;
      let result: TranscribeRecordingResult | undefined = undefined;
      try {
        result = await upload({
          recordingUri: uri,
          model: credentials.model,
          language: current.languageTag,
          organizationId: credentials.organizationId,
          authToken: credentials.authToken,
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted || stale(current)) {
          return;
        }
        fail(current, 'client');
        return;
      }
      if (controller.signal.aborted || stale(current)) {
        return;
      }
      const classification = classifyTranscriptionFailure(result);
      if (classification === 'success' && result.ok && result.text.trim() !== '') {
        current.producedText = true;
        emit('result', {
          isFinal: true,
          results: [{ transcript: result.text, confidence: 1, segments: [] }],
        });
        return;
      }
      if (classification === 'no-speech') {
        // An empty segment is skipped silently; `stop()` reports no-speech
        // only when the whole session produced nothing.
        return;
      }
      // 'unreachable' | 'timeout' | 'model-unavailable' | 'auth' | 'server' |
      // 'invalid-response' → 'gateway-unreachable' | 'gateway-timeout' |
      // 'gateway-model-unavailable' | 'gateway-auth' | 'gateway-server' |
      // 'gateway-invalid-response' — the codes voice-input-state classifies.
      fail(current, `gateway-${classification}`);
    } finally {
      // The upload no longer needs the file; delete it on every path.
      await deleteRecordingFile(deleteRecording, uri);
    }
  };

  /**
   * Queue one segment upload behind the previous ones so their results land
   * in recording order even when a later request finishes first.
   */
  const enqueueSegmentUpload = (current: GatewaySession, uri: string): void => {
    const previous = current.uploadChain;
    current.uploadChain = (async () => {
      await previous;
      await uploadSegment(current, uri);
    })();
  };

  /**
   * Create, prepare, and start a fresh recorder. Returns null when the session
   * was taken over while preparing or when preparation failed (which already
   * terminalized the session); the caller owns the returned handle otherwise.
   */
  const prepareRecorder = async (current: GatewaySession): Promise<RecorderHandle | null> => {
    let handle: RecorderHandle | null = null;
    try {
      await deps.setAudioMode({ allowsRecording: true });
      if (stale(current)) {
        return null;
      }
      const recorder = deps.createRecorder();
      handle = { recorder, released: false };
      try {
        await recorder.prepareToRecordAsync();
      } catch {
        await releaseAndDeleteRecording(handle, deleteRecording);
        handle = null;
        if (!stale(current)) {
          fail(current, 'client');
        }
        return null;
      }
      if (stale(current)) {
        await releaseAndDeleteRecording(handle, deleteRecording);
        handle = null;
        return null;
      }
      recorder.record();
      return handle;
    } catch {
      if (handle) {
        await releaseAndDeleteRecording(handle, deleteRecording);
      }
      if (!stale(current)) {
        fail(current, 'client');
      }
      return null;
    }
  };

  /**
   * End a stopped session once every queued segment upload has landed. Drains
   * the whole chain before deciding no-speech, so the last segment's result is
   * counted. Idempotent: only the first caller emits `end`.
   */
  const finalizeStop = async (current: GatewaySession): Promise<void> => {
    if (current.finalizing) {
      return;
    }
    current.finalizing = true;
    clearRotationTimer(current);
    try {
      await current.uploadChain;
      if (stale(current)) {
        return;
      }
      if (!current.producedText) {
        // Reuse the OS recognizer's empty-recording copy: same user-facing state.
        fail(current, 'no-speech');
        return;
      }
      endSession(current);
    } finally {
      current.finalizing = false;
    }
  };

  /**
   * Stop the segment captured by `stop()`/`startPrep`, upload it, then
   * finalize. Used on the paths that already emitted `transcribing`.
   */
  const completeSegmentAndFinalize = async (
    current: GatewaySession,
    handle: RecorderHandle
  ): Promise<void> => {
    const captured = await detachSegment(handle);
    if (!captured.ok || captured.uri === null || captured.uri === '') {
      if (!stale(current)) {
        fail(current, 'client');
      }
      return;
    }
    enqueueSegmentUpload(current, captured.uri);
    await finalizeStop(current);
  };

  /**
   * One segment elapsed: stop and upload the current recording, then start a
   * fresh recorder and schedule the next rotation. A `stop()` that raced this
   * rotation owns the terminal signals, so the continuation emits
   * `transcribing` and finalizes on its behalf.
   */
  const rotateSegment = async (current: GatewaySession): Promise<void> => {
    clearRotationTimer(current);
    if (stale(current) || current.stopped || current.finalizing) {
      return;
    }
    current.rotationInFlight = true;
    try {
      const handle = current.handle;
      current.handle = null;
      if (handle) {
        const captured = await detachSegment(handle);
        if (!captured.ok || captured.uri === null || captured.uri === '') {
          if (!stale(current)) {
            fail(current, 'client');
          }
          return;
        }
        enqueueSegmentUpload(current, captured.uri);
      }
      if (isStopped(current) || stale(current)) {
        // `stop()` arrived while rotating; it left the terminal signals here.
        if (!stale(current)) {
          emit('transcribing', null);
          await finalizeStop(current);
        }
        return;
      }
      const next = await prepareRecorder(current);
      if (!next) {
        return;
      }
      if (stale(current)) {
        await releaseAndDeleteRecording(next, deleteRecording);
        return;
      }
      if (isStopped(current)) {
        // `stop()` raced the next segment's preparation: stop it, upload it,
        // and finalize now.
        emit('transcribing', null);
        void completeSegmentAndFinalize(current, next);
        return;
      }
      current.handle = next;
      scheduleRotation(current);
    } finally {
      current.rotationInFlight = false;
    }
  };

  /** Arm the next segment rotation unless the session is stopping or gone. */
  const scheduleRotation = (current: GatewaySession): void => {
    if (stale(current) || current.stopped || current.finalizing) {
      return;
    }
    current.rotationTimer = setTimeout(() => {
      current.rotationTimer = null;
      void rotateSegment(current);
    }, segmentDurationMs);
  };

  const startPrep = async (current: GatewaySession): Promise<void> => {
    const handle = await prepareRecorder(current);
    if (!handle) {
      return;
    }
    if (stale(current)) {
      await releaseAndDeleteRecording(handle, deleteRecording);
      return;
    }
    // Only hand the recorder to `stop()`/`abort()` once it can actually
    // record; while preparing, `stop()` sets `stopRequested` instead.
    current.handle = handle;
    emit('start', null);
    current.recordingStarted = true;
    if (current.stopped) {
      // `stop()` arrived while we were still preparing: emit transcribing
      // after start, then run the upload path so the session terminalizes.
      emit('transcribing', null);
      current.handle = null;
      void completeSegmentAndFinalize(current, handle);
      return;
    }
    scheduleRotation(current);
  };

  return {
    addListener(event, listener) {
      const boxed = listener as AnyListener;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(boxed);
      return {
        remove: (): void => {
          listeners.get(event)?.delete(boxed);
        },
      };
    },
    getPermissions: async (): Promise<VoiceInputNativePermission> => {
      const response = await getRecordingPermissionsAsync();
      return { granted: response.granted, canAskAgain: response.canAskAgain };
    },
    requestPermissions: async (): Promise<VoiceInputNativePermission> => {
      const response = await requestRecordingPermissionsAsync();
      return { granted: response.granted, canAskAgain: response.canAskAgain };
    },
    // The gateway path works wherever the network does — that is the point
    // of the setting, and it is what makes the mic button appear on devices
    // whose OS recognizer is missing.
    isRecognitionAvailable: () => true,
    // The gateway `start()` ignores the continuous flag; real time comes from
    // the engine's segment rotation, not from the OS recognizer.
    supportsContinuousRecognition: () => false,
    supportsOnDevice: () => false,
    start: (options: VoiceInputNativeStartOptions): void => {
      // The controller serializes ownership (it aborts the previous session
      // before starting the next), but a direct caller may not. Drop any
      // still-live session so its rotation timer and recorder cannot outlive
      // the new session; the replacement is what makes the old one `stale`.
      const previous = session;
      if (previous) {
        previous.stopped = true;
        clearRotationTimer(previous);
        previous.uploadController?.abort();
        const previousHandle = previous.handle;
        previous.handle = null;
        if (previousHandle) {
          void discardRecording(previousHandle, deleteRecording);
        }
      }
      // Any previous session's upload (if still in flight) owns its own abort
      // controller and cannot emit into this one.
      sessionSeq += 1;
      const current: GatewaySession = {
        credentials: null,
        finalizing: false,
        handle: null,
        id: sessionSeq,
        languageTag: options.lang,
        producedText: false,
        recordingStarted: false,
        rotationInFlight: false,
        rotationTimer: null,
        stopped: false,
        stopRequested: false,
        // eslint-disable-next-line prefer-await-to-then -- Promise.resolve() is the empty-chain sentinel; there is no async context to await in
        uploadChain: Promise.resolve(),
        uploadController: null,
      };
      session = current;
      void startPrep(current);
    },
    stop: (): void => {
      const current = session;
      if (!current) {
        return;
      }
      current.stopped = true;
      clearRotationTimer(current);
      if (current.rotationInFlight) {
        // A rotation is mid-flight; its continuation emits `transcribing` and
        // finalizes once it has captured the in-flight segment.
        return;
      }
      const handle = current.handle;
      if (!handle) {
        // Still preparing; `startPrep` runs the upload path when it lands.
        current.stopRequested = true;
        return;
      }
      // Synchronous first signal: the UI flips to "Transcribing…" before the
      // recorder stop / upload awaits begin.
      emit('transcribing', null);
      current.handle = null;
      void completeSegmentAndFinalize(current, handle);
    },
    abort: (): void => {
      const current = session;
      session = null;
      if (!current) {
        return;
      }
      current.stopped = true;
      clearRotationTimer(current);
      current.uploadController?.abort();
      const handle = current.handle;
      current.handle = null;
      if (handle) {
        // Discard the recording: end capture, free the native object, delete
        // the file. Late segment uploads check `stale`, delete their file,
        // and emit nothing.
        void discardRecording(handle, deleteRecording);
      }
      emit('end', null);
    },
  };
}
