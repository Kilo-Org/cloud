/* eslint-disable max-classes-per-file -- the File mock sits beside the FakeAudioRecorder mock in one suite. */
/* eslint-disable require-await, @typescript-eslint/require-await -- the binding's fakes resolve immediately, so they settle without await */
import { setAudioModeAsync } from 'expo-audio';
import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  gatewayVoiceInputNative,
  resolveGatewayTranscriptionModelId,
} from './native-gateway-voice-input';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
  },
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: vi.fn(async (): Promise<string | null> => 'token-1'),
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (): Promise<string | null> => null),
  setItemAsync: vi.fn(async (): Promise<void> => undefined),
  deleteItemAsync: vi.fn(async (): Promise<void> => undefined),
}));
const storedModel = vi.hoisted(() => ({
  current: null as { id: string; name: string } | null,
}));
const writeTranscriptionModel = vi.hoisted(() =>
  vi.fn<(model: { id: string; name: string } | null) => void>()
);
const modelLoad = vi.hoisted(() => ({
  whenLoaded: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock('./gateway-transcription-preference', () => ({
  readGatewayTranscriptionModel: vi.fn(() => storedModel.current),
  writeGatewayTranscriptionModel: writeTranscriptionModel,
  whenGatewayTranscriptionModelLoaded: modelLoad.whenLoaded,
}));
const transcriptionModels = vi.hoisted(() => ({
  fetchTranscriptionModels: vi.fn(async (): Promise<{ id: string; name: string }[]> => []),
}));
vi.mock('@/lib/hooks/use-transcription-models', () => ({
  fetchTranscriptionModels: transcriptionModels.fetchTranscriptionModels,
  useTranscriptionModels: vi.fn(),
}));

const platformMock = vi.hoisted(() => ({ OS: 'ios' as string }));
vi.mock('react-native', () => ({ Platform: platformMock }));

/** The full nested preset the binding hands to `prepareToRecordAsync`. */
const HIGH_QUALITY = vi.hoisted(() => ({
  extension: '.m4a',
  sampleRate: 44_100,
  numberOfChannels: 2,
  bitRate: 128_000,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: {
    outputFormat: 'aac ',
    audioQuality: 127,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 128_000 },
}));

/** Options handed to each `new AudioModule.AudioRecorder(...)` plus the receiver. */
const recorderBox = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  instances: [] as { preparedWith: unknown }[],
}));

// Mirrors the real expo-audio 57 surface: the native `AudioRecorder`
// constructor takes flattened options, and the package installs a shim on
// `AudioRecorder.prototype.prepareToRecordAsync` that flattens the shared
// nested preset per platform before the native prepare call.
vi.mock('expo-audio', () => {
  class FakeAudioRecorder {
    uri: string | null = null;
    stopped = false;
    released = false;
    preparedWith: unknown = null;

    constructor(options: Record<string, unknown>) {
      recorderBox.calls.push(options);
      recorderBox.instances.push(this);
    }

    async prepareToRecordAsync(options?: Record<string, unknown>): Promise<void> {
      this.preparedWith = options ?? null;
    }

    record(): void {
      this.uri = 'file:///recordings/recording.m4a';
    }

    async stop(): Promise<void> {
      this.stopped = true;
    }

    release(): void {
      this.released = true;
    }
  }
  return {
    AudioModule: { AudioRecorder: FakeAudioRecorder },
    AudioQuality: { MAX: 127 },
    RecordingPresets: { HIGH_QUALITY },
    setAudioModeAsync: vi.fn(async (): Promise<void> => undefined),
    getRecordingPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: false })),
    requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: false })),
  };
});

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      storedResolve?.();
    },
  };
}

describe('gatewayVoiceInputNative recorder construction', () => {
  beforeEach(() => {
    recorderBox.calls.length = 0;
    recorderBox.instances.length = 0;
    platformMock.OS = 'ios';
  });

  it('pairs allowsRecording with playsInSilentMode so expo-audio iOS accepts the recording mode', async () => {
    // expo-audio's native iOS validation throws InvalidAudioModeException
    // when allowsRecording is set while the stored playsInSilentMode is
    // false — and false is the native default. Without the pair the gateway
    // recorder never starts on iOS, so every gateway session dies at start.
    gatewayVoiceInputNative.start(START_OPTIONS);
    await flush();

    expect(vi.mocked(setAudioModeAsync)).toHaveBeenCalledWith({
      allowsRecording: true,
      playsInSilentMode: true,
    });
  });

  it('constructs the recorder with the same shared options on iOS and Android', async () => {
    platformMock.OS = 'ios';
    gatewayVoiceInputNative.start(START_OPTIONS);
    await flush();

    platformMock.OS = 'android';
    gatewayVoiceInputNative.start(START_OPTIONS);
    await flush();

    expect(recorderBox.calls).toHaveLength(2);
    // One implementation for both platforms: the construction options are
    // byte-identical, no per-platform record is applied at construction.
    expect(recorderBox.calls[0]).toStrictEqual(recorderBox.calls[1]);
    const [options] = recorderBox.calls;
    expect(options).toStrictEqual({
      extension: '.m4a',
      sampleRate: 44_100,
      numberOfChannels: 2,
      bitRate: 128_000,
      isMeteringEnabled: false,
      // iOS-only constructor requirement (no Android equivalent field): the
      // iOS deserializer rejects the construction without a top-level
      // `audioQuality`; Android ignores the unknown key.
      audioQuality: 127,
    });
    expect(options).not.toHaveProperty('ios');
    expect(options).not.toHaveProperty('android');
    expect(options).not.toHaveProperty('web');
    expect(options).not.toHaveProperty('outputFormat');
  });

  it.each(['ios', 'android'] as const)(
    'hands the full nested preset to prepareToRecordAsync on %s, where the expo-audio shim flattens it',
    async os => {
      platformMock.OS = os;

      gatewayVoiceInputNative.start(START_OPTIONS);
      await flush();

      expect(recorderBox.instances).toHaveLength(1);
      // Identity: the binding passes the shared preset object through to the
      // shimmed prototype method, which applies the platform record on both.
      expect(recorderBox.instances[0]?.preparedWith).toBe(HIGH_QUALITY);
    }
  );
});

describe('resolveGatewayTranscriptionModelId', () => {
  beforeEach(() => {
    storedModel.current = null;
    transcriptionModels.fetchTranscriptionModels.mockReset();
    writeTranscriptionModel.mockReset();
    modelLoad.whenLoaded.mockReset();
    modelLoad.whenLoaded.mockImplementation(async () => undefined);
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  });

  it('returns the stored model without reading the catalogue', async () => {
    storedModel.current = { id: 'stored-model', name: 'Stored Model' };

    await expect(resolveGatewayTranscriptionModelId()).resolves.toEqual({
      id: 'stored-model',
      name: 'Stored Model',
    });
    expect(transcriptionModels.fetchTranscriptionModels).not.toHaveBeenCalled();
    expect(writeTranscriptionModel).not.toHaveBeenCalled();
  });

  it('scopes the catalogue read to the stored organization', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('org-42');
    transcriptionModels.fetchTranscriptionModels.mockResolvedValue([
      { id: 'org-model', name: 'Org Model' },
    ]);

    await expect(resolveGatewayTranscriptionModelId()).resolves.toEqual({
      id: 'org-model',
      name: 'Org Model',
    });
    expect(transcriptionModels.fetchTranscriptionModels).toHaveBeenCalledWith('org-42');
  });

  it('falls back to the first catalogue entry and persists it when none is stored', async () => {
    transcriptionModels.fetchTranscriptionModels.mockResolvedValue([
      { id: 'first-model', name: 'First Model' },
      { id: 'second-model', name: 'Second Model' },
    ]);

    await expect(resolveGatewayTranscriptionModelId()).resolves.toEqual({
      id: 'first-model',
      name: 'First Model',
    });
    // Persisted so the auto-picked model survives launches even if the user
    // never opens the settings page.
    expect(writeTranscriptionModel).toHaveBeenCalledWith({
      id: 'first-model',
      name: 'First Model',
    });
  });

  it('does not overwrite an existing stored model', async () => {
    storedModel.current = { id: 'stored-model', name: 'Stored Model' };

    await resolveGatewayTranscriptionModelId();

    expect(writeTranscriptionModel).not.toHaveBeenCalled();
  });

  it('awaits the stored-model read before falling back, so a cold start cannot overwrite an existing choice', async () => {
    const load = deferred();
    modelLoad.whenLoaded.mockReturnValueOnce(load.promise);
    transcriptionModels.fetchTranscriptionModels.mockResolvedValue([
      { id: 'first-model', name: 'First Model' },
    ]);
    storedModel.current = null;

    const pending = resolveGatewayTranscriptionModelId();

    // The disk read lands with the user's existing choice, then the store load
    // settles. The resolver must keep that choice, not persist the fallback.
    storedModel.current = { id: 'stored-model', name: 'Stored Model' };
    load.resolve();

    await expect(pending).resolves.toEqual({ id: 'stored-model', name: 'Stored Model' });
    expect(transcriptionModels.fetchTranscriptionModels).not.toHaveBeenCalled();
    expect(writeTranscriptionModel).not.toHaveBeenCalled();
  });

  it('reads an empty catalogue as no model and writes nothing', async () => {
    transcriptionModels.fetchTranscriptionModels.mockResolvedValue([]);

    await expect(resolveGatewayTranscriptionModelId()).resolves.toBeNull();
    expect(writeTranscriptionModel).not.toHaveBeenCalled();
  });

  it('reads an unreachable catalogue as no model and writes nothing', async () => {
    transcriptionModels.fetchTranscriptionModels.mockRejectedValue(new Error('offline'));

    await expect(resolveGatewayTranscriptionModelId()).resolves.toBeNull();
    expect(writeTranscriptionModel).not.toHaveBeenCalled();
  });
});
