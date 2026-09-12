/* eslint-disable max-lines -- the engine suite covers every session path (happy, error mapping, abort, prep races) on one fake harness. */
/* eslint-disable require-await, @typescript-eslint/require-await -- the engine's fake deps resolve immediately, so they settle without await */
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { type VoiceInputNativeEvent } from '../voice-input-controller';
import {
  type TranscribeRecordingInput,
  type TranscribeRecordingResult,
} from './gateway-transcription-client';
import {
  createGatewayVoiceInputEngine,
  type GatewayRecorder,
  type GatewayVoiceInputEngineDeps,
} from './gateway-voice-input-engine';

vi.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  File: class {
    createUploadTask = vi.fn();
  },
}));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

const audioMock = vi.hoisted(() => ({
  getRecordingPermissionsAsync: vi.fn(),
  requestRecordingPermissionsAsync: vi.fn(),
}));
vi.mock('expo-audio', () => audioMock);

type RecordedEvent = { event: keyof VoiceInputNativeEvent; payload: unknown };

const START_OPTIONS = {
  continuous: false,
  interimResults: true,
  lang: 'en-US',
  maxAlternatives: 1,
  requiresOnDeviceRecognition: false,
} as const;

/** Let every queued microtask/timer continuation of the engine run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each macrotask turn lets the engine's chained continuations settle
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
  }
}

type FakeRecorder = GatewayRecorder & {
  prepareToRecordAsync: Mock<() => Promise<void>>;
  record: Mock<() => void>;
  stop: Mock<() => Promise<void>>;
  release: Mock<() => void>;
};

function makeRecorder(uri: string | null = null): FakeRecorder {
  const recorder = {
    uri,
    prepareToRecordAsync: vi.fn(async (): Promise<void> => undefined),
    record: vi.fn((): void => {
      // A real recorder exposes its file URI only once it is recording.
      recorder.uri ??= 'file:///recordings/recording.m4a';
    }),
    stop: vi.fn(async (): Promise<void> => undefined),
    release: vi.fn((): void => undefined),
  };
  return recorder;
}

type UploadMock = Mock<(input: TranscribeRecordingInput) => Promise<TranscribeRecordingResult>>;

function buildEngine(overrides: Partial<GatewayVoiceInputEngineDeps> = {}): {
  engine: ReturnType<typeof createGatewayVoiceInputEngine>;
  events: RecordedEvent[];
  recorder: FakeRecorder;
  upload: UploadMock;
  deleteRecording: Mock<(uri: string) => Promise<void>>;
} {
  const recorder = makeRecorder();
  const events: RecordedEvent[] = [];
  const upload = vi.fn(
    async (): Promise<TranscribeRecordingResult> => ({ ok: true, text: 'hello world' })
  );
  const deleteRecording = vi.fn(async (): Promise<void> => undefined);
  const deps: GatewayVoiceInputEngineDeps = {
    setAudioMode: vi.fn(async (): Promise<void> => undefined),
    createRecorder: vi.fn(() => recorder),
    readModelId: vi.fn(async () => ({ id: 'whisper-large-v3', name: 'Whisper Large v3' })),
    readAuthToken: vi.fn(async (): Promise<string | null> => 'token-1'),
    readOrganizationId: vi.fn(async (): Promise<string | null> => 'org-1'),
    deleteRecording,
    upload,
    ...overrides,
  };
  const engine = createGatewayVoiceInputEngine(deps);
  for (const event of [
    'start',
    'transcribing',
    'result',
    'nomatch',
    'error',
    'end',
  ] as (keyof VoiceInputNativeEvent)[]) {
    engine.addListener(event, payload => {
      events.push({ event, payload });
    });
  }
  return { engine, events, recorder, upload, deleteRecording };
}

/** Drain the engine's queued microtasks without advancing the fake clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each pass lets one chained continuation land
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function startAndStop(
  engine: ReturnType<typeof createGatewayVoiceInputEngine>
): Promise<void> {
  engine.start(START_OPTIONS);
  await flush();
  engine.stop();
}

beforeEach(() => {
  audioMock.getRecordingPermissionsAsync.mockReset();
  audioMock.requestRecordingPermissionsAsync.mockReset();
});

describe('createGatewayVoiceInputEngine', () => {
  it('emits start, then transcribing synchronously on stop, then the final result and end', async () => {
    const { engine, events, recorder, upload } = buildEngine();

    engine.start(START_OPTIONS);
    await flush();
    expect(events.map(entry => entry.event)).toEqual(['start']);

    engine.stop();
    // The transcribing signal fires before any await so the UI flips to
    // "Transcribing…" without a gap.
    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing']);

    await flush();
    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'result', 'end']);
    const result = events[2]?.payload as VoiceInputNativeEvent['result'];
    expect(result.isFinal).toBe(true);
    expect(result.results[0]?.transcript).toBe('hello world');
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.release).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    const input = upload.mock.calls[0]?.[0];
    expect(input?.recordingUri).toBe('file:///recordings/recording.m4a');
    expect(input?.model).toEqual({ id: 'whisper-large-v3', name: 'Whisper Large v3' });
    expect(input?.language).toBe('en-US');
    expect(input?.authToken).toBe('token-1');
    expect(input?.organizationId).toBe('org-1');
  });

  it('maps an unavailable model to gateway-model-unavailable and terminalizes with end', async () => {
    const { engine, events } = buildEngine({
      upload: async (): Promise<TranscribeRecordingResult> => ({
        ok: false,
        status: 404,
        isTimeout: false,
        isNetworkError: false,
      }),
    });

    await startAndStop(engine);
    await flush();

    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'error', 'end']);
    const errorPayload = events[2]?.payload as VoiceInputNativeEvent['error'];
    expect(errorPayload.error).toBe('gateway-model-unavailable');
  });

  it('maps unreachable, timeout, server and invalid-response to their gateway codes', async () => {
    const cases: [TranscribeRecordingResult, string][] = [
      [{ ok: false, isTimeout: false, isNetworkError: true }, 'gateway-unreachable'],
      [{ ok: false, isTimeout: true, isNetworkError: false }, 'gateway-timeout'],
      [{ ok: false, status: 503, isTimeout: false, isNetworkError: false }, 'gateway-server'],
      [
        { ok: false, status: 200, isTimeout: false, isNetworkError: false },
        'gateway-invalid-response',
      ],
    ];
    for (const [result, code] of cases) {
      const { engine, events } = buildEngine({ upload: async () => result });
      // eslint-disable-next-line no-await-in-loop -- each case needs its own fully settled engine session
      await startAndStop(engine);
      // eslint-disable-next-line no-await-in-loop -- the upload continuation must drain before asserting
      await flush();
      const errorPayload = events[2]?.payload as VoiceInputNativeEvent['error'];
      expect(errorPayload.error).toBe(code);
      expect(events[3]?.event).toBe('end');
    }
  });

  it('maps an empty transcription to the existing no-speech error', async () => {
    const { engine, events } = buildEngine({
      upload: async (): Promise<TranscribeRecordingResult> => ({ ok: true, text: '   ' }),
    });

    await startAndStop(engine);
    await flush();

    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'error', 'end']);
    const errorPayload = events[2]?.payload as VoiceInputNativeEvent['error'];
    expect(errorPayload.error).toBe('no-speech');
  });

  it('emits gateway-no-model without uploading when no model is chosen', async () => {
    const { engine, events, upload } = buildEngine({ readModelId: async () => null });

    await startAndStop(engine);
    await flush();

    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'error', 'end']);
    const errorPayload = events[2]?.payload as VoiceInputNativeEvent['error'];
    expect(errorPayload.error).toBe('gateway-no-model');
    expect(upload).not.toHaveBeenCalled();
  });

  it('emits gateway-auth without uploading when no auth token is available', async () => {
    const { engine, events, upload } = buildEngine({
      readAuthToken: async () => null,
    });

    await startAndStop(engine);
    await flush();

    const errorPayload = events[2]?.payload as VoiceInputNativeEvent['error'];
    expect(errorPayload.error).toBe('gateway-auth');
    expect(upload).not.toHaveBeenCalled();
  });

  it('emits client error and end when recording prep fails', async () => {
    const { engine, events } = buildEngine({
      setAudioMode: async () => {
        throw new Error('audio mode refused');
      },
    });

    engine.start(START_OPTIONS);
    await flush();

    expect(events.map(entry => entry.event)).toEqual(['error', 'end']);
    const errorPayload = events[0]?.payload as VoiceInputNativeEvent['error'];
    expect(errorPayload.error).toBe('client');
  });

  it('abort during upload emits end with no result and aborts the upload signal', async () => {
    const uploadInputs: TranscribeRecordingInput[] = [];
    const uploadResolvers: ((value: TranscribeRecordingResult) => void)[] = [];
    const { engine, events } = buildEngine({
      upload: async input => {
        uploadInputs.push(input);
        return new Promise<TranscribeRecordingResult>(resolve => {
          uploadResolvers.push(resolve);
        });
      },
    });

    await startAndStop(engine);
    await flush();
    const capturedSignal = uploadInputs[0]?.signal;
    expect(capturedSignal).toBeDefined();
    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing']);

    engine.abort();
    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'end']);
    expect(capturedSignal?.aborted).toBe(true);

    // The late upload answer must not resurrect the session.
    uploadResolvers[0]?.({ ok: true, text: 'too late' });
    await flush();
    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'end']);
  });

  it('abort during recording stops and releases the recorder without a result', async () => {
    const { engine, events, recorder } = buildEngine();

    engine.start(START_OPTIONS);
    await flush();
    engine.abort();

    expect(events.map(entry => entry.event)).toEqual(['start', 'end']);
    await flush();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.release).toHaveBeenCalledTimes(1);
  });

  it('stop during prep still terminalizes with start, transcribing, result and end', async () => {
    const prepState: { resolve?: () => void } = {};
    const recorder = makeRecorder();
    recorder.prepareToRecordAsync.mockImplementation(
      async () =>
        new Promise<void>(resolve => {
          prepState.resolve = resolve;
        })
    );
    const { engine, events } = buildEngine({ createRecorder: () => recorder });

    engine.start(START_OPTIONS);
    await flush();
    engine.stop();
    prepState.resolve?.();
    await flush();

    expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'result', 'end']);
  });

  it('stop and abort are no-ops when no session is active', async () => {
    const { engine, events } = buildEngine();

    engine.stop();
    engine.abort();
    await flush();

    expect(events).toEqual([]);
  });

  it('a second start after terminalization runs a fresh session', async () => {
    const { engine, events } = buildEngine();

    await startAndStop(engine);
    await flush();
    engine.start(START_OPTIONS);
    await flush();
    engine.stop();
    await flush();

    expect(events.map(entry => entry.event)).toEqual([
      'start',
      'transcribing',
      'result',
      'end',
      'start',
      'transcribing',
      'result',
      'end',
    ]);
  });

  it('is always available and never continuous or on-device', () => {
    const { engine } = buildEngine();
    expect(engine.isRecognitionAvailable()).toBe(true);
    expect(engine.supportsContinuousRecognition()).toBe(false);
    expect(engine.supportsOnDevice()).toBe(false);
  });

  it('delegates permissions to the expo-audio recording permission', async () => {
    audioMock.getRecordingPermissionsAsync.mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: false,
      expires: 'never',
    });
    audioMock.requestRecordingPermissionsAsync.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: true,
      expires: 'never',
    });
    const { engine } = buildEngine();

    await expect(engine.getPermissions()).resolves.toEqual({
      granted: true,
      canAskAgain: false,
    });
    await expect(engine.requestPermissions()).resolves.toEqual({
      granted: false,
      canAskAgain: true,
    });
  });

  it('remove() detaches a listener', async () => {
    const { engine } = buildEngine();
    const seen: string[] = [];
    const subscription = engine.addListener('start', () => {
      seen.push('start');
    });
    subscription.remove();

    engine.start(START_OPTIONS);
    await flush();

    expect(seen).toEqual([]);
  });
});

describe('recording file cleanup', () => {
  it('deletes the recording file after a successful upload', async () => {
    const { engine, deleteRecording } = buildEngine();

    await startAndStop(engine);
    await flush();

    expect(deleteRecording).toHaveBeenCalledWith('file:///recordings/recording.m4a');
  });

  it('deletes the recording file after a classified upload failure', async () => {
    const { engine, deleteRecording } = buildEngine({
      upload: async (): Promise<TranscribeRecordingResult> => ({
        ok: false,
        status: 503,
        isTimeout: false,
        isNetworkError: false,
      }),
    });

    await startAndStop(engine);
    await flush();

    expect(deleteRecording).toHaveBeenCalledWith('file:///recordings/recording.m4a');
  });

  it('deletes the recording file on a model short-circuit', async () => {
    const { engine, deleteRecording } = buildEngine({ readModelId: async () => null });

    await startAndStop(engine);
    await flush();

    expect(deleteRecording).toHaveBeenCalledWith('file:///recordings/recording.m4a');
  });

  it('deletes the recording file when an upload is aborted', async () => {
    const uploadResolvers: ((value: TranscribeRecordingResult) => void)[] = [];
    const { engine, deleteRecording } = buildEngine({
      upload: async () =>
        new Promise<TranscribeRecordingResult>(resolve => {
          uploadResolvers.push(resolve);
        }),
    });

    await startAndStop(engine);
    await flush();
    expect(deleteRecording).not.toHaveBeenCalled();

    engine.abort();
    uploadResolvers[0]?.({ ok: true, text: 'too late' });
    await flush();

    expect(deleteRecording).toHaveBeenCalledWith('file:///recordings/recording.m4a');
  });

  it('deletes the recording file when recording is aborted before upload', async () => {
    const { engine, deleteRecording } = buildEngine();

    engine.start(START_OPTIONS);
    await flush();
    engine.abort();
    await flush();

    expect(deleteRecording).toHaveBeenCalledWith('file:///recordings/recording.m4a');
  });
});

describe('progressive segment rotation', () => {
  it('emits a final result while listening when a segment elapses, then stop ends the session', async () => {
    vi.useFakeTimers();
    try {
      const { engine, events } = buildEngine({ segmentDurationMs: 40 });

      engine.start(START_OPTIONS);
      await settle();
      expect(events.map(entry => entry.event)).toEqual(['start']);

      await vi.advanceTimersByTimeAsync(40);
      await settle();

      // The segment transcribed before the user stopped; the status is still
      // `listening`, so `transcribing` has not fired yet.
      expect(events.map(entry => entry.event)).toEqual(['start', 'result']);
      const result = events[1]?.payload as VoiceInputNativeEvent['result'];
      expect(result.isFinal).toBe(true);
      expect(result.results[0]?.transcript).toBe('hello world');

      engine.stop();
      await settle();

      expect(events.map(entry => entry.event)).toEqual([
        'start',
        'result',
        'transcribing',
        'result',
        'end',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop finalizes the in-flight segment and drains queued uploads in order', async () => {
    vi.useFakeTimers();
    try {
      let sequence = 0;
      const pending: { uri: string; resolve: (result: TranscribeRecordingResult) => void }[] = [];
      const { engine, events } = buildEngine({
        createRecorder: () => {
          sequence += 1;
          return makeRecorder(`file:///recordings/segment-${sequence}.m4a`);
        },
        segmentDurationMs: 30,
        upload: async input =>
          new Promise<TranscribeRecordingResult>(resolve => {
            pending.push({ uri: input.recordingUri, resolve });
          }),
      });

      engine.start(START_OPTIONS);
      await settle();
      await vi.advanceTimersByTimeAsync(30);
      await settle();
      await vi.advanceTimersByTimeAsync(30);
      await settle();
      // Two rotations queued segment 1 and 2; stop captures the in-flight 3.
      engine.stop();
      await settle();

      // Uploads are serialized: only the first starts until it resolves.
      expect(pending.map(entry => entry.uri)).toEqual(['file:///recordings/segment-1.m4a']);

      pending[0]?.resolve({ ok: true, text: 'one' });
      await settle();
      expect(pending.map(entry => entry.uri)).toEqual([
        'file:///recordings/segment-1.m4a',
        'file:///recordings/segment-2.m4a',
      ]);

      pending[1]?.resolve({ ok: true, text: 'two' });
      await settle();
      // The segment captured by stop() drains last.
      expect(pending.map(entry => entry.uri)).toEqual([
        'file:///recordings/segment-1.m4a',
        'file:///recordings/segment-2.m4a',
        'file:///recordings/segment-3.m4a',
      ]);

      pending[2]?.resolve({ ok: true, text: 'three' });
      await settle();

      const transcripts = events
        .filter(entry => entry.event === 'result')
        .map(entry => (entry.payload as VoiceInputNativeEvent['result']).results[0]?.transcript);
      expect(transcripts).toEqual(['one', 'two', 'three']);
      expect(events.map(entry => entry.event)).toEqual([
        'start',
        'transcribing',
        'result',
        'result',
        'result',
        'end',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['', '   '])('emits no-speech for empty segments (%j) and allows retry', async text => {
    vi.useFakeTimers();
    try {
      const { engine, events, upload } = buildEngine({
        segmentDurationMs: 30,
      });
      upload.mockResolvedValue({ ok: true, text });

      engine.start(START_OPTIONS);
      await settle();
      await vi.advanceTimersByTimeAsync(30);
      await settle();
      await vi.advanceTimersByTimeAsync(30);
      await settle();
      // Empty segments are skipped silently while listening.
      expect(events.map(entry => entry.event)).toEqual(['start']);

      engine.stop();
      await settle();

      expect(events.map(entry => entry.event)).toEqual(['start', 'transcribing', 'error', 'end']);
      const errorPayload = events[2]?.payload as VoiceInputNativeEvent['error'];
      expect(errorPayload.error).toBe('no-speech');

      // A silent session never emits a draft write. A new microphone tap can
      // still transcribe normally using the same engine after the error ends.
      upload.mockResolvedValue({ ok: true, text: 'retry words' });
      engine.start(START_OPTIONS);
      await settle();
      engine.stop();
      await settle();
      expect(events.slice(4).map(entry => entry.event)).toEqual([
        'start',
        'transcribing',
        'result',
        'end',
      ]);
      const resultPayload = events[6]?.payload as VoiceInputNativeEvent['result'];
      expect(resultPayload.results[0]?.transcript).toBe('retry words');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mid-session segment failure emits the gateway error and keeps the earlier result', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { engine, events } = buildEngine({
        segmentDurationMs: 30,
        upload: async (): Promise<TranscribeRecordingResult> => {
          calls += 1;
          return calls === 1
            ? { ok: true, text: 'first words' }
            : { ok: false, isTimeout: false, isNetworkError: true };
        },
      });

      engine.start(START_OPTIONS);
      await settle();
      await vi.advanceTimersByTimeAsync(30);
      await settle();
      expect(events.map(entry => entry.event)).toEqual(['start', 'result']);

      await vi.advanceTimersByTimeAsync(30);
      await settle();

      expect(events.map(entry => entry.event)).toEqual(['start', 'result', 'error', 'end']);
      const errorPayload = events[2]?.payload as VoiceInputNativeEvent['error'];
      expect(errorPayload.error).toBe('gateway-unreachable');
      const resultPayload = events[1]?.payload as VoiceInputNativeEvent['result'];
      expect(resultPayload.results[0]?.transcript).toBe('first words');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepares the successor while the predecessor records, then hands off capture', async () => {
    vi.useFakeTimers();
    try {
      const trace: string[] = [];
      const recorders: FakeRecorder[] = [];
      const makeTracedRecorder = (label: string): FakeRecorder => ({
        uri: `file:///recordings/${label}.m4a`,
        prepareToRecordAsync: vi.fn(async (): Promise<void> => {
          trace.push(`${label}:prepare`);
        }),
        record: vi.fn((): void => {
          trace.push(`${label}:record`);
        }),
        stop: vi.fn(async (): Promise<void> => {
          trace.push(`${label}:stop`);
        }),
        release: vi.fn((): void => {
          trace.push(`${label}:release`);
        }),
      });
      const { engine } = buildEngine({
        createRecorder: () => {
          const label = `seg-${recorders.length + 1}`;
          const recorder = makeTracedRecorder(label);
          recorders.push(recorder);
          return recorder;
        },
        segmentDurationMs: 30,
      });

      engine.start(START_OPTIONS);
      await settle();
      expect(trace).toEqual(['seg-1:prepare', 'seg-1:record']);

      await vi.advanceTimersByTimeAsync(30);
      await settle();

      // The microphone is never idle across the rotation: the successor is
      // created and prepared while the predecessor still captures, and capture
      // only moves in the stop -> record handoff.
      expect(trace).toEqual([
        'seg-1:prepare',
        'seg-1:record',
        'seg-2:prepare',
        'seg-1:stop',
        'seg-2:record',
        'seg-1:release',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort clears the rotation timer so no further recorder is created', async () => {
    vi.useFakeTimers();
    try {
      const createRecorder = vi.fn(() => makeRecorder());
      const { engine, events } = buildEngine({ createRecorder, segmentDurationMs: 40 });

      engine.start(START_OPTIONS);
      await settle();
      expect(createRecorder).toHaveBeenCalledTimes(1);

      engine.abort();
      await vi.advanceTimersByTimeAsync(80);
      await settle();

      expect(events.map(entry => entry.event)).toEqual(['start', 'end']);
      expect(createRecorder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
