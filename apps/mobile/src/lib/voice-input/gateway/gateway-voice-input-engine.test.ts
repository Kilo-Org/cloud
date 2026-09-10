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

function makeRecorder(): FakeRecorder {
  const recorder = {
    uri: null as string | null,
    prepareToRecordAsync: vi.fn(async (): Promise<void> => undefined),
    record: vi.fn((): void => {
      recorder.uri = 'file:///recordings/recording.m4a';
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
