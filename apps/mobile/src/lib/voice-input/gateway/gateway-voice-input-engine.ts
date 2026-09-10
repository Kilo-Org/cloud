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
   * Defaults to the real gateway client; tests inject a fake. Declared as a
   * property (not a method) so the engine can hold a detached reference.
   */
  upload?: ((input: TranscribeRecordingInput) => Promise<TranscribeRecordingResult>) | undefined;
};

type RecorderHandle = {
  released: boolean;
  recorder: GatewayRecorder;
};

type GatewaySession = {
  /** Monotonic id; every async continuation checks it still owns the session. */
  id: number;
  /** BCP-47 hint carried from `start()` into the transcription upload. */
  languageTag: string;
  /** The recorder we currently own, or null once `stop()` has taken it. */
  handle: RecorderHandle | null;
  /** Set when `stop()` arrives while the recorder is still preparing. */
  stopRequested: boolean;
  /** Owns the in-flight upload; `abort()` cancels it. */
  uploadController: AbortController | null;
};

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
 * Discard an aborted recording: end capture, then free the native object.
 * A recorder that refuses to stop (sync throw or rejection) still gets
 * released, exactly once.
 */
async function discardRecording(handle: RecorderHandle): Promise<void> {
  try {
    await handle.recorder.stop();
  } catch {
    // The session is already gone; the release below is what matters.
  }
  releaseRecorder(handle);
}

/**
 * Gateway transcription engine: record with expo-audio, upload the file to
 * the Kilo gateway, and emit the transcript as a single final result. It
 * implements the same `VoiceInputNative` protocol as the OS binding so the
 * controller cannot tell them apart.
 *
 * Event protocol per session: `start` → (`stop()`) `transcribing` →
 * `result`|`error` → `end`. `abort()` ends the session without a result.
 * Every failure path terminalizes with `error` + `end` so the controller's
 * session never hangs; the recorder's native object is released on every
 * path that stops owning it.
 */
export function createGatewayVoiceInputEngine(deps: GatewayVoiceInputEngineDeps): VoiceInputNative {
  const upload = deps.upload ?? transcribeRecording;
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

  const fail = (current: GatewaySession, code: string): void => {
    emit('error', { error: code, message: `gateway-voice-input: ${code}` });
    endSession(current);
  };

  const startPrep = async (current: GatewaySession): Promise<void> => {
    try {
      await deps.setAudioMode({ allowsRecording: true });
      if (stale(current)) {
        return;
      }
      const recorder = deps.createRecorder();
      const handle: RecorderHandle = { recorder, released: false };
      try {
        await recorder.prepareToRecordAsync();
      } catch {
        releaseRecorder(handle);
        if (!stale(current)) {
          fail(current, 'client');
        }
        return;
      }
      if (stale(current)) {
        releaseRecorder(handle);
        return;
      }
      // Only hand the recorder to `stop()`/`abort()` once it can actually
      // record; while preparing, `stop()` sets `stopRequested` instead.
      current.handle = handle;
      recorder.record();
      emit('start', null);
      if (current.stopRequested) {
        // `stop()` arrived while we were still preparing: run the upload
        // path now so the session still terminalizes.
        emit('transcribing', null);
        current.handle = null;
        void finishSession(current, handle);
      }
    } catch {
      if (stale(current)) {
        return;
      }
      if (current.handle) {
        releaseRecorder(current.handle);
        current.handle = null;
      }
      fail(current, 'client');
    }
  };

  const finishSession = async (current: GatewaySession, handle: RecorderHandle): Promise<void> => {
    const { recorder } = handle;
    try {
      await recorder.stop();
    } catch {
      releaseRecorder(handle);
      if (!stale(current)) {
        fail(current, 'client');
      }
      return;
    }
    const uri = recorder.uri;
    releaseRecorder(handle);
    if (stale(current)) {
      return;
    }
    if (uri === null || uri === '') {
      fail(current, 'client');
      return;
    }
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
      // Without a token the gateway will answer 401; tell the user to sign in
      // instead of burning an upload round-trip.
      fail(current, 'gateway-auth');
      return;
    }
    const controller = new AbortController();
    current.uploadController = controller;
    let result: TranscribeRecordingResult | undefined = undefined;
    try {
      result = await upload({
        recordingUri: uri,
        model,
        language: current.languageTag,
        organizationId,
        authToken,
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted || stale(current)) {
        return;
      }
      fail(current, 'client');
      return;
    }
    if (controller.signal.aborted) {
      // `abort()` cancelled the upload and already emitted `end`.
      return;
    }
    if (stale(current)) {
      return;
    }
    const classification = classifyTranscriptionFailure(result);
    if (classification === 'success' && result.ok) {
      emit('result', {
        isFinal: true,
        results: [{ transcript: result.text, confidence: 1, segments: [] }],
      });
      endSession(current);
      return;
    }
    if (classification === 'no-speech') {
      // Reuse the OS recognizer's empty-recording copy: same user-facing state.
      fail(current, 'no-speech');
      return;
    }
    // 'unreachable' | 'timeout' | 'model-unavailable' | 'auth' | 'server' |
    // 'invalid-response' → 'gateway-unreachable' | 'gateway-timeout' |
    // 'gateway-model-unavailable' | 'gateway-auth' | 'gateway-server' |
    // 'gateway-invalid-response' — the codes voice-input-state classifies.
    fail(current, `gateway-${classification}`);
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
    // One recording, one upload: no continuous mode, nothing on-device.
    supportsContinuousRecognition: () => false,
    supportsOnDevice: () => false,
    start: (options: VoiceInputNativeStartOptions): void => {
      // Any previous session's upload (if still in flight) owns its own abort
      // controller and cannot emit into this one.
      sessionSeq += 1;
      const current: GatewaySession = {
        handle: null,
        id: sessionSeq,
        languageTag: options.lang,
        stopRequested: false,
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
      if (!current.handle) {
        // Still preparing; `startPrep` runs the upload path when it lands.
        current.stopRequested = true;
        return;
      }
      // Synchronous first signal: the UI flips to "Transcribing…" before the
      // recorder stop / upload awaits begin.
      emit('transcribing', null);
      const handle = current.handle;
      current.handle = null;
      void finishSession(current, handle);
    },
    abort: (): void => {
      const current = session;
      session = null;
      if (!current) {
        return;
      }
      current.stopRequested = true;
      current.uploadController?.abort();
      const handle = current.handle;
      current.handle = null;
      if (handle) {
        // Discard the recording: end capture, then free the native object.
        void discardRecording(handle);
      }
      emit('end', null);
    },
  };
}
